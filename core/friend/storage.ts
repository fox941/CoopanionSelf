/** StateCoordinator serializes source-backed state changes within one locked runtime directory. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireInstanceLock, type InstanceLock } from 'cortico/core/instance-lock.ts';
import { applyFriendMigrations } from './migrations.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export type MemoryScope = 'self' | 'owner_private' | 'shared' | `conversation:${string}`;
export type FriendEventSource = 'desktop' | 'qq' | 'video' | 'timer' | 'reflection' | 'operator';

export interface SourceEvent {
  source: FriendEventSource;
  key: string;
  scope: MemoryScope;
  occurredAt: string;
  /** The envelope records an observation or statement; its payload need not be true. */
  payload: JsonObject;
}

export interface StateSnapshot {
  profileId: string;
  revision: number;
  state: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface PendingOperation { id: string; kind: string; payload: JsonObject }
export interface StoredOperation extends PendingOperation {
  sourceEventId: string;
  status: 'pending' | 'running' | 'completed' | 'uncertain';
  attempts: number;
  claimToken: string | null;
  result: JsonObject | null;
}

export interface StateChange {
  consumer: string;
  event: SourceEvent;
  expectedRevision: number;
  /** Complete next state, computed from the expected revision. No personality defaults are added. */
  state: JsonObject;
  reason: string;
  operations?: readonly PendingOperation[];
}

export interface ApplyResult {
  applied: boolean;
  sourceEventId: string;
  appliedRevision: number;
  snapshot: StateSnapshot;
}

export class StateRevisionConflict extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Friend state revision changed: expected ${expected}, found ${actual}.`);
    this.name = 'StateRevisionConflict';
  }
}

interface StateRow { profile_id: string; revision: number; state_json: string; created_at: string; updated_at: string }
interface SourceRow { id: string; fingerprint: string }
interface OperationRow {
  operation_id: string; source_event_id: string; kind: string; payload_json: string;
  status: StoredOperation['status']; attempts: number; claim_token: string | null; result_json: string | null;
}

const SOURCES = new Set(['desktop', 'qq', 'video', 'timer', 'reflection', 'operator']);

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function nonempty(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be nonempty.`);
}

/** Canonical JSON makes redelivery independent of object property insertion order. */
function encode(value: JsonObject): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return JSON.stringify(value, (_key, part: unknown) => {
    if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
    if (typeof part === 'number' && Number.isFinite(part)) return part;
    if (Array.isArray(part)) return part;
    if (typeof part === 'object' && part !== null && [Object.prototype, null].includes(Object.getPrototypeOf(part))) {
      return Object.fromEntries(Object.entries(part).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    throw new Error('State and event payloads must contain finite JSON values.');
  });
}

function timestamp(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('Event time must include a timezone.');
  return new Date(ms).toISOString();
}

function eventData(event: SourceEvent): { occurredAt: string; payload: string; fingerprint: string } {
  if (!SOURCES.has(event.source)) throw new Error('Unknown friend event source.');
  nonempty(event.key, 'Event key');
  if (!['self', 'owner_private', 'shared'].includes(event.scope)
    && !/^conversation:[^\r\n]+$/.test(event.scope)) throw new Error('Invalid memory scope.');
  const occurredAt = timestamp(event.occurredAt);
  const payload = encode(event.payload);
  return { occurredAt, payload, fingerprint: hash(JSON.stringify([event.scope, occurredAt, payload])) };
}

function operation(row: OperationRow): StoredOperation {
  return {
    id: row.operation_id, sourceEventId: row.source_event_id, kind: row.kind,
    payload: JSON.parse(row.payload_json) as JsonObject, status: row.status, attempts: row.attempts,
    claimToken: row.claim_token, result: row.result_json === null ? null : JSON.parse(row.result_json) as JsonObject,
  };
}

/** The directory lock is held until close(), including across asynchronous application work. */
export class StateCoordinator {
  private closed = false;

  private constructor(
    private readonly db: DatabaseSync,
    readonly databasePath: string,
    private readonly lock: InstanceLock,
    private readonly clock: () => number,
  ) {}

  static open(runtimeRoot: string, options: { clock?: () => number } = {}): StateCoordinator {
    const directory = resolve(runtimeRoot, 'friend');
    mkdirSync(directory, { recursive: true });
    const lock = acquireInstanceLock(directory);
    const file = join(directory, 'friend.sqlite');
    const fresh = !existsSync(file);
    const clock = options.clock ?? Date.now;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
      db.exec('PRAGMA busy_timeout = 5000');
      const store = new StateCoordinator(db, file, lock, clock);
      store.initialize(fresh);
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      // A lost process cannot establish whether work already had its external effect.
      db.prepare("UPDATE outbox SET status = 'uncertain', claim_token = NULL, updated_at = ? WHERE status = 'running'").run(store.now());
      return store;
    } catch (error) {
      try { db?.close(); } finally { lock.release(); }
      throw error;
    }
  }

  private now(): string { return new Date(this.clock()).toISOString(); }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private initialize(fresh: boolean): void {
    this.transaction(() => {
      applyFriendMigrations(this.db, { fresh, now: this.now() });
      if (fresh) {
        const now = this.now();
        this.db.prepare("INSERT INTO profile_state (singleton, profile_id, revision, state_json, created_at, updated_at) VALUES (1, ?, 0, '{}', ?, ?)")
          .run(randomUUID(), now, now);
      }
      if (!this.db.prepare('SELECT singleton FROM profile_state WHERE singleton = 1').get()) {
        throw new Error('Friend database has no character identity; automatic replacement is disabled.');
      }
    });
  }

  snapshot(): StateSnapshot {
    const row = this.db.prepare('SELECT * FROM profile_state WHERE singleton = 1').get() as unknown as StateRow;
    return { profileId: row.profile_id, revision: row.revision, state: JSON.parse(row.state_json) as JsonObject, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private source(event: SourceEvent, data: ReturnType<typeof eventData>): string {
    const found = this.db.prepare('SELECT id, fingerprint FROM source_events WHERE source = ? AND event_key = ?').get(event.source, event.key) as unknown as SourceRow | undefined;
    if (found) {
      if (found.fingerprint !== data.fingerprint) throw new Error('An existing source event has different content or scope.');
      return found.id;
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO source_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, event.source, event.key, event.scope, data.occurredAt, this.now(), data.payload, data.fingerprint);
    return id;
  }

  recordSource(event: SourceEvent): string {
    const data = eventData(event);
    return this.transaction(() => this.source(event, data));
  }

  readSource(id: string): (SourceEvent & { id: string; receivedAt: string }) | null {
    const row = this.db.prepare('SELECT * FROM source_events WHERE id = ?').get(id);
    return row ? {
      id, source: row.source as FriendEventSource, key: row.event_key as string, scope: row.scope as MemoryScope,
      occurredAt: row.occurred_at as string, receivedAt: row.received_at as string, payload: JSON.parse(row.payload_json as string) as JsonObject,
    } : null;
  }

  /** Source, state revision, audit record, consumer receipt and operations commit together. */
  apply(change: StateChange): ApplyResult {
    nonempty(change.consumer, 'Consumer');
    nonempty(change.reason, 'Change reason');
    if (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0) throw new Error('Expected revision must be a nonnegative safe integer.');
    const data = eventData(change.event);
    const state = encode(change.state);
    const operations = (change.operations ?? []).map(op => {
      nonempty(op.id, 'Operation id'); nonempty(op.kind, 'Operation kind');
      return { ...op, encoded: encode(op.payload) };
    });
    return this.transaction(() => {
      const id = this.source(change.event, data);
      const receipt = this.db.prepare('SELECT applied_revision FROM processed_events WHERE consumer = ? AND source_event_id = ?').get(change.consumer, id);
      const current = this.snapshot();
      if (receipt) return { applied: false, sourceEventId: id, appliedRevision: receipt.applied_revision as number, snapshot: current };
      if (current.revision !== change.expectedRevision) throw new StateRevisionConflict(change.expectedRevision, current.revision);
      const revision = current.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('Friend state revision exceeds the safe integer range.');
      const now = this.now();
      this.db.prepare('UPDATE profile_state SET revision = ?, state_json = ?, updated_at = ? WHERE singleton = 1').run(revision, state, now);
      this.db.prepare('INSERT INTO state_changes VALUES (?, ?, ?, ?, ?, ?)').run(revision, id, change.consumer, state, change.reason, now);
      this.db.prepare('INSERT INTO processed_events VALUES (?, ?, ?)').run(change.consumer, id, revision);
      for (const op of operations) {
        this.db.prepare("INSERT INTO outbox (operation_id, source_event_id, kind, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
          .run(op.id, id, op.kind, op.encoded, now, now);
      }
      return { applied: true, sourceEventId: id, appliedRevision: revision, snapshot: this.snapshot() };
    });
  }

  history(afterRevision = 0): Array<{ revision: number; sourceEventId: string; consumer: string; state: JsonObject; reason: string; recordedAt: string }> {
    return this.db.prepare('SELECT * FROM state_changes WHERE revision > ? ORDER BY revision').all(afterRevision).map(row => ({
      revision: row.revision as number, sourceEventId: row.source_event_id as string, consumer: row.consumer as string,
      state: JSON.parse(row.state_json as string) as JsonObject, reason: row.reason as string, recordedAt: row.recorded_at as string,
    }));
  }

  operations(status?: StoredOperation['status']): StoredOperation[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM outbox WHERE status = ? ORDER BY created_at, operation_id').all(status)
      : this.db.prepare('SELECT * FROM outbox ORDER BY created_at, operation_id').all();
    return (rows as unknown as OperationRow[]).map(operation);
  }

  claimOperation(): StoredOperation | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at, operation_id LIMIT 1").get() as unknown as OperationRow | undefined;
      if (!row) return null;
      const token = randomUUID();
      this.db.prepare("UPDATE outbox SET status = 'running', attempts = attempts + 1, claim_token = ?, updated_at = ? WHERE operation_id = ?")
        .run(token, this.now(), row.operation_id);
      return operation({ ...row, status: 'running', attempts: row.attempts + 1, claim_token: token });
    });
  }

  completeOperation(id: string, claimToken: string, result: JsonObject): void {
    const encoded = encode(result);
    const changed = this.db.prepare("UPDATE outbox SET status = 'completed', result_json = ?, claim_token = NULL, updated_at = ? WHERE operation_id = ? AND status = 'running' AND claim_token = ?")
      .run(encoded, this.now(), id, claimToken);
    if (changed.changes !== 1) throw new Error('Operation claim is no longer active.');
  }

  /** The caller must verify an interrupted operation's effect before resolving or retrying it. */
  resolveUncertain(id: string, resolution: { result: JsonObject } | { retry: true }): void {
    const completed = 'result' in resolution;
    const encoded = completed ? encode(resolution.result) : null;
    const changed = this.db.prepare("UPDATE outbox SET status = ?, result_json = ?, updated_at = ? WHERE operation_id = ? AND status = 'uncertain'")
      .run(completed ? 'completed' : 'pending', encoded, this.now(), id);
    if (changed.changes !== 1) throw new Error('Operation is not awaiting reconciliation.');
  }

  /** Database-only snapshot; a whole character backup also includes workspace and Cortico data. */
  backupTo(destination: string): void {
    const file = resolve(destination);
    if (file === this.databasePath) throw new Error('Backup destination must differ from the active database.');
    mkdirSync(dirname(file), { recursive: true });
    closeSync(openSync(file, 'wx'));
    try {
      this.db.prepare('VACUUM INTO ?').run(file);
      const fd = openSync(file, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) {
      unlinkSync(file);
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
    this.lock.release();
  }
}
