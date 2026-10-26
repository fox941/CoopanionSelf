import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBot, type BotDefinition } from 'cortico/bot.ts';
import { loadDeployment } from 'cortico/deploy.ts';
import { InstanceLockedError } from 'cortico/core/instance-lock.ts';
import cormini from '../vendor/cortico/bots/cormini/index.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { friendPersona } from '../core/friend-persona.ts';
import { StateCoordinator, StateRevisionConflict, type SourceEvent, type StateChange } from '../core/friend/storage.ts';
import { FRIEND_MIGRATIONS, FRIEND_SCHEMA_VERSION } from '../core/friend/schema.ts';
import { applyFriendMigrations } from '../core/friend/migrations.ts';
import { FriendStorageRuntime } from '../core/friend/runtime.ts';

const roots: string[] = [];
const stores = new Set<StateCoordinator>();
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'friend-storage-'));
  roots.push(directory);
  return directory;
}
function open(directory = root(), clock?: () => number): StateCoordinator {
  const store = StateCoordinator.open(directory, { clock });
  stores.add(store);
  return store;
}
function sql<T>(file: string, work: (db: DatabaseSync) => T, readOnly = true): T {
  const db = new DatabaseSync(file, { readOnly });
  try { return work(db); } finally { db.close(); }
}
function event(key = 'event-1'): SourceEvent {
  return { source: 'operator', key, scope: 'self', occurredAt: '2026-01-01T12:00:00Z', payload: { observation: 'An isolated fixture event.' } };
}
function change(overrides: Partial<StateChange> = {}): StateChange {
  return { consumer: 'fixture', event: event(), expectedRevision: 0, state: { attention: 'A fixture topic.' }, reason: 'Fixture change grounded in the event.', ...overrides };
}
function count(store: StateCoordinator, table: string): number {
  if (!['source_events', 'processed_events', 'state_changes', 'outbox'].includes(table)) throw new Error('Unexpected table.');
  return sql(store.databasePath, db => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n as number);
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});
afterAll(() => {
  for (const directory of roots) {
    if (dirname(directory) !== tmpdir() || !directory.startsWith(join(tmpdir(), 'friend-storage-'))) throw new Error('Unexpected test directory.');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Friend persistent state', () => {
  it('creates an empty character state and preserves its identity across restarts', () => {
    const directory = root();
    const store = open(directory);
    const first = store.snapshot();
    expect(first.profileId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).toMatchObject({ revision: 0, state: {} });
    expect(store.databasePath).toBe(join(directory, 'friend', 'friend.sqlite'));
    expect(sql(store.databasePath, db => db.prepare('PRAGMA user_version').get()!.user_version)).toBe(FRIEND_SCHEMA_VERSION);
    expect(sql(store.databasePath, db => db.prepare('PRAGMA journal_mode').get()!.journal_mode)).toBe('wal');
    store.close();
    store.close();
    expect(open(directory).snapshot()).toEqual(first);
  });

  it('commits source, state, receipt, change history and pending work as one unit', () => {
    const store = open();
    const applied = store.apply(change({ operations: [{ id: 'document-1', kind: 'file_projection', payload: { revision: 1 } }] }));
    expect(applied).toMatchObject({ applied: true, appliedRevision: 1, snapshot: { revision: 1 } });
    expect(store.readSource(applied.sourceEventId)).toMatchObject({ ...event(), occurredAt: '2026-01-01T12:00:00.000Z' });
    expect(store.history()).toEqual([expect.objectContaining({ revision: 1, sourceEventId: applied.sourceEventId, state: change().state, reason: change().reason })]);
    expect(store.operations('pending')).toEqual([expect.objectContaining({ id: 'document-1', sourceEventId: applied.sourceEventId, status: 'pending', attempts: 0 })]);
    expect(count(store, 'source_events')).toBe(1);
    expect(count(store, 'processed_events')).toBe(1);
  });

  it('deduplicates redelivery after a restart without restoring an older state', () => {
    const directory = root();
    const store = open(directory);
    store.apply(change());
    store.apply(change({ event: event('event-2'), expectedRevision: 1, state: { attention: 'A later topic.' } }));
    store.close();
    const restarted = open(directory);
    const duplicate = restarted.apply(change());
    expect(duplicate).toMatchObject({ applied: false, appliedRevision: 1, snapshot: { revision: 2, state: { attention: 'A later topic.' } } });
    expect(restarted.history()).toHaveLength(2);
    expect(count(restarted, 'source_events')).toBe(2);
  });

  it('stores a source independently and deduplicates JSON with different property order', () => {
    const store = open();
    const first = store.recordSource({ ...event(), payload: { outer: { a: 1, b: 2 }, items: ['x', 'y'] } });
    const repeated = store.recordSource({ ...event(), payload: { items: ['x', 'y'], outer: { b: 2, a: 1 } } });
    expect(repeated).toBe(first);
    expect(store.snapshot().revision).toBe(0);
    expect(store.history()).toEqual([]);
  });

  it.each([
    { payload: { observation: 'Changed evidence.' } },
    { scope: 'shared' as const },
    { occurredAt: '2026-01-02T12:00:00Z' },
  ])('rejects changed evidence under an existing event key: %j', override => {
    const store = open();
    const id = store.recordSource(event());
    expect(() => store.recordSource({ ...event(), ...override })).toThrow('different content or scope');
    expect(store.readSource(id)?.payload).toEqual(event().payload);
    expect(count(store, 'source_events')).toBe(1);
  });

  it('tracks the same source independently for separate consumers', () => {
    const store = open();
    const first = store.apply(change());
    const next = store.apply(change({ consumer: 'another-fixture', expectedRevision: 1, state: { settled: true } }));
    expect(next).toMatchObject({ applied: true, sourceEventId: first.sourceEventId, appliedRevision: 2 });
    expect(count(store, 'source_events')).toBe(1);
    expect(count(store, 'processed_events')).toBe(2);
  });

  it('rejects an outdated snapshot and rolls back its new source', () => {
    const store = open();
    store.apply(change());
    expect(() => store.apply(change({ event: event('stale'), state: { lost: true } }))).toThrow(StateRevisionConflict);
    expect(store.snapshot()).toMatchObject({ revision: 1, state: change().state });
    expect(count(store, 'source_events')).toBe(1);
    expect(store.history()).toHaveLength(1);
  });

  it('rolls back every record when an operation constraint fails after the state write', () => {
    const store = open();
    const before = store.snapshot();
    const op = { id: 'duplicate-operation', kind: 'file_projection', payload: {} };
    expect(() => store.apply(change({ operations: [op, op] }))).toThrow();
    expect(store.snapshot()).toEqual(before);
    for (const table of ['source_events', 'processed_events', 'state_changes', 'outbox']) expect(count(store, table)).toBe(0);
    expect(store.apply(change()).applied).toBe(true);
  });

  it('keeps occurrence time separate from recording time and returns detached state', () => {
    let now = Date.parse('2026-01-03T12:00:00Z');
    const store = open(root(), () => now);
    now += 60_000;
    const applied = store.apply(change());
    expect(store.readSource(applied.sourceEventId)).toMatchObject({ occurredAt: '2026-01-01T12:00:00.000Z', receivedAt: '2026-01-03T12:01:00.000Z' });
    const snapshot = store.snapshot();
    snapshot.state.attention = 'Changed only in the caller.';
    expect(store.snapshot().state).toEqual(change().state);
  });

  it.each([
    { state: { value: Number.NaN } },
    { event: { ...event(), scope: 'invalid' as never } },
    { event: { ...event(), occurredAt: '2026-01-01 12:00:00' } },
    { expectedRevision: -1 },
  ])('rejects malformed boundary input before writing: %j', override => {
    const store = open();
    expect(() => store.apply(change(override))).toThrow();
    expect(store.snapshot()).toMatchObject({ revision: 0, state: {} });
    expect(count(store, 'source_events')).toBe(0);
  });

  it('refuses a second writer, including one in the same process', () => {
    const directory = root();
    const first = open(directory);
    const id = first.snapshot().profileId;
    expect(() => open(directory)).toThrow(InstanceLockedError);
    first.close();
    expect(open(directory).snapshot().profileId).toBe(id);
  });

  it('preserves a complete character directory when copied to a new location', () => {
    const directory = root();
    const store = open(directory);
    store.apply(change());
    const saved = store.snapshot();
    const workspace = join(directory, 'home', 'companion', 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'CONSTITUTION.md'), 'A fixture character-authored description.');
    store.close();
    const destination = root();
    cpSync(directory, destination, { recursive: true });
    const migrated = open(destination);
    expect(migrated.snapshot()).toEqual(saved);
    expect(migrated.apply(change()).applied).toBe(false);
    expect(readFileSync(join(destination, 'home/companion/workspace/CONSTITUTION.md'), 'utf8')).toBe('A fixture character-authored description.');
  });

  it('creates a database snapshot including committed WAL data and never overwrites a destination', () => {
    const store = open();
    store.apply(change());
    const destination = root();
    const file = join(destination, 'friend', 'friend.sqlite');
    store.backupTo(file);
    expect(open(destination).snapshot()).toEqual(store.snapshot());
    expect(() => store.backupTo(file)).toThrow();
    expect(() => store.backupTo(store.databasePath)).toThrow('must differ');
  });

  it.each(['newer-version', 'changed-migration', 'missing-identity'])('refuses incompatible data without creating a replacement character: %s', scenario => {
    const directory = root();
    const store = open(directory);
    const id = store.snapshot().profileId;
    store.close();
    sql(store.databasePath, db => {
      if (scenario === 'newer-version') db.exec(`PRAGMA user_version = ${FRIEND_SCHEMA_VERSION + 1}`);
      if (scenario === 'changed-migration') db.exec("UPDATE schema_migrations SET checksum = 'changed'");
      if (scenario === 'missing-identity') db.exec('DELETE FROM profile_state');
    }, false);
    expect(() => open(directory)).toThrow();
    const rows = sql(store.databasePath, db => db.prepare('SELECT profile_id FROM profile_state').all());
    expect(rows).toEqual(scenario === 'missing-identity' ? [] : [{ profile_id: id }]);
    expect(() => open(directory)).not.toThrow(InstanceLockedError);
  });

  it.each(['empty', 'unrelated', 'corrupt'])('refuses an existing unrecognized file without clearing it: %s', scenario => {
    const directory = root();
    const file = join(directory, 'friend', 'friend.sqlite');
    mkdirSync(dirname(file), { recursive: true });
    if (scenario === 'unrelated') sql(file, db => db.exec('CREATE TABLE unrelated (value TEXT);'), false);
    else writeFileSync(file, scenario === 'corrupt' ? 'Not a database.' : '');
    const before = readFileSync(file);
    expect(() => open(directory)).toThrow();
    expect(readFileSync(file)).toEqual(before);
  });
});

describe('Schema migrations', () => {
  it('upgrades a version-one character without changing identity, state or source evidence', () => {
    const directory = root();
    const file = join(directory, 'friend', 'friend.sqlite');
    mkdirSync(dirname(file), { recursive: true });
    sql(file, db => {
      db.exec('BEGIN IMMEDIATE');
      applyFriendMigrations(db, { fresh: true, now: '2026-01-01T00:00:00.000Z' }, [FRIEND_MIGRATIONS[0]]);
      db.prepare('INSERT INTO profile_state VALUES (1, ?, 4, ?, ?, ?)').run('existing-character', '{"learned":true}', '2026-01-01', '2026-01-02');
      db.prepare('INSERT INTO source_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('existing-source', 'desktop', 'original-message', 'owner_private', '2026-01-01', '2026-01-01', '{"text":"Original evidence"}', 'original-hash');
      db.exec('COMMIT');
    }, false);
    const store = open(directory);
    expect(store.snapshot()).toMatchObject({ profileId: 'existing-character', revision: 4, state: { learned: true } });
    expect(store.readSource('existing-source')?.payload).toEqual({ text: 'Original evidence' });
    expect(sql(file, db => db.prepare('SELECT count(*) AS n FROM memory_entries').get()!.n)).toBe(0);
    expect(sql(file, db => db.prepare('PRAGMA foreign_key_check').all())).toEqual([]);
    store.close();
    expect(open(directory).snapshot().profileId).toBe('existing-character');
  });

  it('applies an appended migration once while preserving identity and state', () => {
    const store = open();
    store.apply(change());
    const saved = store.snapshot();
    store.close();
    sql(store.databasePath, db => {
      const migrations = [...FRIEND_MIGRATIONS, { version: FRIEND_SCHEMA_VERSION + 1, sql: 'ALTER TABLE profile_state ADD COLUMN fixture INTEGER NOT NULL DEFAULT 7;' }];
      for (let attempt = 0; attempt < 2; attempt++) {
        db.exec('BEGIN IMMEDIATE');
        try {
          applyFriendMigrations(db, { fresh: false, now: '2026-01-04T00:00:00.000Z' }, migrations);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      expect(db.prepare('SELECT profile_id, revision, fixture FROM profile_state').get()).toEqual({ profile_id: saved.profileId, revision: saved.revision, fixture: 7 });
      expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n).toBe(migrations.length);
    }, false);
  });

  it('rolls back a failed migration, including its schema and version changes', () => {
    const directory = root();
    const store = open(directory);
    store.apply(change());
    const saved = store.snapshot();
    store.close();
    sql(store.databasePath, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        expect(() => applyFriendMigrations(db, { fresh: false, now: '2026-01-04T00:00:00.000Z' }, [
          ...FRIEND_MIGRATIONS,
          { version: FRIEND_SCHEMA_VERSION + 1, sql: 'ALTER TABLE profile_state ADD COLUMN fixture TEXT; INSERT INTO absent_table VALUES (1);' },
        ])).toThrow();
      } finally { db.exec('ROLLBACK'); }
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(FRIEND_SCHEMA_VERSION);
      expect(db.prepare('PRAGMA table_info(profile_state)').all().some(column => column.name === 'fixture')).toBe(false);
    }, false);
    expect(open(directory).snapshot()).toEqual(saved);
  });
});

describe('Recoverable operations', () => {
  function prepared() {
    const directory = root();
    const store = open(directory);
    store.apply(change({ operations: [{ id: 'work-1', kind: 'file_projection', payload: { document: 'fixture.md' } }] }));
    return { directory, store };
  }

  it('claims once and accepts completion only from the current claim', () => {
    const { store } = prepared();
    const claimed = store.claimOperation()!;
    expect(claimed).toMatchObject({ id: 'work-1', status: 'running', attempts: 1 });
    expect(store.claimOperation()).toBeNull();
    expect(() => store.completeOperation(claimed.id, 'wrong-token', {})).toThrow('no longer active');
    store.completeOperation(claimed.id, claimed.claimToken!, { written: true });
    expect(store.operations()).toEqual([expect.objectContaining({ status: 'completed', claimToken: null, result: { written: true } })]);
  });

  it('marks interrupted work uncertain on restart and requires reconciliation before retry', () => {
    const { directory, store } = prepared();
    const old = store.claimOperation()!;
    store.close();
    const restarted = open(directory);
    expect(restarted.claimOperation()).toBeNull();
    expect(restarted.operations('uncertain')).toHaveLength(1);
    expect(() => restarted.completeOperation(old.id, old.claimToken!, {})).toThrow();
    restarted.resolveUncertain(old.id, { retry: true });
    const next = restarted.claimOperation()!;
    expect(next.attempts).toBe(2);
    expect(next.claimToken).not.toBe(old.claimToken);
    expect(() => restarted.completeOperation(old.id, old.claimToken!, {})).toThrow();
    restarted.completeOperation(next.id, next.claimToken!, { verified: true });
  });

  it('records a verified interrupted result without repeating the operation', () => {
    const { directory, store } = prepared();
    store.claimOperation();
    store.close();
    const restarted = open(directory);
    restarted.resolveUncertain('work-1', { result: { foundExisting: true } });
    expect(restarted.claimOperation()).toBeNull();
    expect(restarted.operations('completed')[0].result).toEqual({ foundExisting: true });
    restarted.close();
    expect(open(directory).operations('completed')).toHaveLength(1);
  });
});

describe('Storage lifecycle', () => {
  it('opens storage through a real bot lifecycle and releases it on stop', async () => {
    const directory = root();
    const deployment = join(directory, 'home', 'companion');
    mkdirSync(deployment, { recursive: true });
    const runtime = new FriendStorageRuntime(directory);
    const Persona = friendPersona(Cormini);
    const definition: BotDefinition = {
      ...cormini,
      build: loaded => ({
        persona: new Persona({ memoryDir: loaded.memoryDir, friend: { enabled: () => false, readSnapshot: () => null } }),
        llm: { respond: async () => { throw new Error('A paused storage test must not call a model.'); } } as never,
        onStart: () => { stores.add(runtime.start()); },
        onStop: () => runtime.stop(),
        webUi: { enabled: false },
      }),
    };
    const loaded = loadDeployment(definition, deployment, resolve(import.meta.dirname, '../vendor/cortico'));
    const bot = createBot(loaded, definition);
    bot.core.bus.setPaused(true);
    const file = join(directory, 'friend', 'friend.sqlite');
    expect(existsSync(file)).toBe(false);
    try {
      await bot.start();
      expect(runtime.status()).toMatchObject({ ready: true, databasePath: file, schemaVersion: FRIEND_SCHEMA_VERSION, revision: 0 });
      expect(readFileSync(join(loaded.memoryDir, 'CONSTITUTION.md'), 'utf8')).toBe('');
      expect(readFileSync(join(loaded.memoryDir, 'SYSTEM.md'), 'utf8')).toBe('');
    } finally { await bot.stop(); }
    expect(runtime.status().ready).toBe(false);
    expect(open(directory).snapshot().revision).toBe(0);
  });
});
