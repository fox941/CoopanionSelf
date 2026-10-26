/** SQLite metadata and publication journal for immutable Markdown memory revisions. */
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryScope } from './storage.ts';

export type MemoryKind = 'statement' | 'observation' | 'reflection' | 'inference' | 'fiction' | 'commitment';
export type MemorySubject = 'owner' | 'self' | 'other';
export interface MemoryParent { id: string; revision: number }
export interface MemoryVersion {
  id: string; revision: number; scope: MemoryScope; status: 'active' | 'stale' | 'retracted';
  title: string; kind: MemoryKind; subject: MemorySubject; versionStatus: 'active' | 'retracted';
  path: string; hash: string; pendingDocument: string | null; published: boolean; recordedAt: string;
  sourceIds: string[]; parents: MemoryParent[];
}
export interface MemoryPublication {
  id: string; expectedRevision: number; requestKey: string; fingerprint: string;
  scope: MemoryScope; title: string; kind: MemoryKind; subject: MemorySubject;
  status: 'active' | 'retracted'; path: string; hash: string; document: string;
  sourceIds: string[]; parents: MemoryParent[];
}

export class MemoryIndex {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string) {}

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private version(row: Record<string, unknown>): MemoryVersion {
    const id = row.memory_id as string;
    const revision = row.revision as number;
    return {
      id, revision, scope: row.scope as MemoryScope, status: row.current_status as MemoryVersion['status'],
      title: row.title as string, kind: row.kind as MemoryKind, subject: row.subject as MemorySubject,
      versionStatus: row.status as MemoryVersion['versionStatus'], path: row.document_path as string,
      hash: row.document_hash as string, pendingDocument: row.pending_document as string | null,
      published: row.published === 1, recordedAt: row.recorded_at as string,
      sourceIds: this.db.prepare('SELECT source_event_id FROM memory_evidence WHERE memory_id = ? AND revision = ? ORDER BY source_event_id').all(id, revision).map(r => r.source_event_id as string),
      parents: this.db.prepare('SELECT parent_id, parent_revision FROM memory_links WHERE child_id = ? AND child_revision = ? ORDER BY parent_id').all(id, revision).map(r => ({ id: r.parent_id as string, revision: r.parent_revision as number })),
    };
  }

  find(id: string, scopes: readonly MemoryScope[], revision?: number): MemoryVersion | null {
    if (!scopes.length) return null;
    const row = this.db.prepare(`SELECT v.*, e.scope, e.status AS current_status FROM memory_entries e
      JOIN memory_versions v ON v.memory_id = e.id AND v.revision = ${revision === undefined ? 'e.revision' : '?'}
      WHERE e.id = ? AND e.scope IN (${scopes.map(() => '?').join(',')})`)
      .get(...(revision === undefined ? [] : [revision]), id, ...scopes);
    return row ? this.version(row) : null;
  }

  request(key: string, fingerprint: string): MemoryVersion | null {
    const row = this.db.prepare(`SELECT v.*, e.scope, e.status AS current_status FROM memory_versions v
      JOIN memory_entries e ON e.id = v.memory_id WHERE request_key = ?`).get(key);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new Error('Memory operation key was reused with different content.');
    return this.version(row);
  }

  private descendants(id: string): string[] {
    return this.db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT l.child_id FROM memory_links l JOIN memory_entries e ON e.id = l.child_id AND e.revision = l.child_revision WHERE l.parent_id = ?
      UNION
      SELECT l.child_id FROM memory_links l JOIN memory_entries e ON e.id = l.child_id AND e.revision = l.child_revision JOIN descendants d ON l.parent_id = d.id
    ) SELECT id FROM descendants`).all(id).map(row => row.id as string);
  }

  prepare(input: MemoryPublication): MemoryVersion {
    return this.transaction(() => {
      const repeated = this.request(input.requestKey, input.fingerprint);
      if (repeated) return repeated;
      const existing = this.db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(input.id);
      if ((existing?.revision ?? 0) !== input.expectedRevision) throw new Error('Memory revision changed; read the latest version before revising it.');
      if (existing && existing.scope !== input.scope) throw new Error('Memory scope cannot be changed by a revision.');
      if (existing && !this.find(input.id, [input.scope])?.published) throw new Error('The previous memory revision is awaiting publication.');
      const descendants = this.descendants(input.id);
      if (input.parents.some(p => p.id === input.id || descendants.includes(p.id))) throw new Error('Memory derivations must not form a cycle.');
      for (const parent of input.parents) {
        const current = this.find(parent.id, [input.scope, 'shared']);
        if (!current || !current.published || current.status !== 'active' || current.revision !== parent.revision || current.kind === 'fiction' && input.kind !== 'fiction') {
          throw new Error('Derived memory requires a current, accessible parent; fiction stays fiction.');
        }
      }
      for (const sourceId of input.sourceIds) {
        const row = this.db.prepare('SELECT scope FROM source_events WHERE id = ?').get(sourceId);
        if (!row || row.scope !== input.scope && row.scope !== 'shared') throw new Error('Memory evidence is unavailable in the destination scope.');
      }
      const now = this.now();
      const revision = input.expectedRevision + 1;
      this.db.prepare(`INSERT INTO memory_entries VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, status = excluded.status, updated_at = excluded.updated_at`)
        .run(input.id, input.scope, revision, input.status, now, now);
      this.db.prepare('INSERT INTO memory_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
        .run(input.id, revision, input.requestKey, input.fingerprint, input.title, input.kind, input.subject, input.status, input.path, input.hash, input.document, now);
      for (const sourceId of input.sourceIds) this.db.prepare('INSERT INTO memory_evidence VALUES (?, ?, ?)').run(input.id, revision, sourceId);
      for (const parent of input.parents) this.db.prepare('INSERT INTO memory_links VALUES (?, ?, ?, ?)').run(input.id, revision, parent.id, parent.revision);
      for (const id of [input.id, ...descendants]) this.db.prepare('DELETE FROM memory_search WHERE memory_id = ?').run(id);
      for (const id of descendants) this.db.prepare("UPDATE memory_entries SET status = 'stale', updated_at = ? WHERE id = ? AND status = 'active'").run(now, id);
      return this.find(input.id, [input.scope])!;
    });
  }

  pending(): MemoryVersion[] {
    return this.db.prepare(`SELECT v.*, e.scope, e.status AS current_status FROM memory_versions v
      JOIN memory_entries e ON e.id = v.memory_id WHERE published = 0 ORDER BY v.recorded_at, v.revision`).all().map(row => this.version(row));
  }

  publish(version: MemoryVersion, titleTokens: string, bodyTokens: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE memory_versions SET published = 1, pending_document = NULL WHERE memory_id = ? AND revision = ?').run(version.id, version.revision);
      const current = this.find(version.id, [version.scope]);
      if (current?.revision !== version.revision) return;
      this.db.prepare('DELETE FROM memory_search WHERE memory_id = ?').run(version.id);
      if (current.status === 'active') this.db.prepare('INSERT INTO memory_search VALUES (?, ?, ?)').run(version.id, titleTokens, bodyTokens);
    });
  }

  search(match: string, scopes: readonly MemoryScope[], limit: number): MemoryVersion[] {
    if (!match || !scopes.length) return [];
    return this.db.prepare(`SELECT v.*, e.scope, e.status AS current_status FROM memory_search
      JOIN memory_entries e ON e.id = memory_search.memory_id
      JOIN memory_versions v ON v.memory_id = e.id AND v.revision = e.revision
      WHERE memory_search MATCH ? AND e.status = 'active' AND v.published = 1 AND e.scope IN (${scopes.map(() => '?').join(',')})
      ORDER BY bm25(memory_search, 0, 3, 1), e.updated_at DESC, e.id LIMIT ?`)
      .all(match, ...scopes, limit).map(row => this.version(row));
  }

  counts(): { entries: number; pending: number; stale: number } {
    return {
      entries: this.db.prepare('SELECT count(*) AS n FROM memory_entries').get()!.n as number,
      pending: this.db.prepare('SELECT count(*) AS n FROM memory_versions WHERE published = 0').get()!.n as number,
      stale: this.db.prepare("SELECT count(*) AS n FROM memory_entries WHERE status = 'stale'").get()!.n as number,
    };
  }
}
