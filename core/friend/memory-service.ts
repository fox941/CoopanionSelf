/** Source-backed Markdown memory with scoped retrieval and recoverable publication. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { MemoryKind, MemoryParent, MemorySubject, MemoryVersion } from './memory-index.ts';
import type { MemoryScope, SourceEvent, StateCoordinator } from './storage.ts';

export interface MemoryAccess { readonly readScopes: readonly MemoryScope[]; readonly writeScope: MemoryScope }
export interface MemoryHistory {
  ensureRepo(): void;
  available(): boolean;
  commitAll(message: string, author: { name: string; email: string }): string | null;
  commitAllAsync(message: string, author: { name: string; email: string }): Promise<string | null>;
  status(): { repo: boolean; dirty: boolean; commitError: string | null };
}
export type MemoryHistoryFactory = (directory: string, warn: (message: string) => void) => MemoryHistory;
const MEMORY_AUTHOR = { name: 'friend', email: 'friend@persona.local' };
export const DESKTOP_MEMORY_ACCESS: MemoryAccess = Object.freeze({ readScopes: Object.freeze(['owner_private', 'self', 'shared'] as const), writeScope: 'owner_private' });
export interface MemoryInput {
  requestKey: string; id?: string; expectedRevision?: number; title: string; text: string;
  kind: MemoryKind; subject: MemorySubject; status?: 'active' | 'retracted';
  sourceIds: string[]; parents?: MemoryParent[];
}
export interface MemoryHit {
  id: string; revision: number; title: string; kind: MemoryKind; subject: MemorySubject;
  scope: MemoryScope; status: MemoryVersion['status']; sourceIds: string[]; parents: MemoryParent[]; excerpt: string;
}
const KINDS = new Set(['statement', 'observation', 'reflection', 'inference', 'fiction', 'commitment']);
const SUBJECTS = new Set(['owner', 'self', 'other']);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Lexical fallback: ICU words and adjacent Han pairs handle unspaced Chinese queries. */
export function memoryTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const segment of segmenter.segment(text.normalize('NFKC').toLowerCase())) {
    if (!segment.isWordLike) continue;
    if (segment.segment.length <= 80) terms.add(segment.segment);
    for (const run of segment.segment.match(/\p{Script=Han}+/gu) ?? []) {
      const chars = [...run];
      for (let i = 0; i < chars.length - 1; i++) terms.add(chars[i]! + chars[i + 1]!);
    }
  }
  return [...terms];
}

function bodyOf(document: string): string {
  const end = document.indexOf('\n---\n\n');
  if (!document.startsWith('---\n') || end < 0) throw new Error('Memory document header is invalid.');
  return document.slice(end + 6);
}
function summary(version: MemoryVersion): Omit<MemoryHit, 'excerpt'> {
  return { id: version.id, revision: version.revision, title: version.title, kind: version.kind, subject: version.subject,
    scope: version.scope, status: version.status, sourceIds: version.sourceIds, parents: version.parents };
}
function validate(input: MemoryInput): void {
  if (!input.requestKey || input.requestKey.length > 300) throw new Error('A stable memory operation key is required.');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160) throw new Error('Memory title must contain 1 to 160 characters.');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000) throw new Error('Memory text must contain 1 to 8000 characters.');
  if (!KINDS.has(input.kind) || !SUBJECTS.has(input.subject) || input.status !== undefined && !['active', 'retracted'].includes(input.status)) throw new Error('Invalid memory classification.');
  if (input.id !== undefined && !/^[0-9a-f-]{36}$/.test(input.id)) throw new Error('Invalid memory id.');
  if (input.id ? !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 1 : input.expectedRevision !== undefined && input.expectedRevision !== 0) throw new Error('Revisions require the current revision; new memories start at zero.');
  if (!Array.isArray(input.sourceIds) || input.sourceIds.length > 16 || input.sourceIds.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid evidence ids.');
  if (!Array.isArray(input.parents ?? []) || (input.parents?.length ?? 0) > 16 || input.parents?.some(p => !p || !/^[0-9a-f-]{36}$/.test(p.id) || !Number.isSafeInteger(p.revision) || p.revision < 1)) throw new Error('Invalid parent memory revisions.');
  if (!input.sourceIds.length && !input.parents?.length) throw new Error('A memory requires source evidence or a parent memory.');
  if (new Set(input.parents?.map(p => p.id)).size !== (input.parents?.length ?? 0)) throw new Error('Parent memories must be unique.');
}

export class MemoryService {
  readonly directory: string;
  private readonly index;
  private readonly git: MemoryHistory | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly store: StateCoordinator, options: { history?: MemoryHistoryFactory; warn?: (message: string) => void } = {}) {
    this.directory = join(dirname(store.databasePath), 'memory');
    mkdirSync(this.directory, { recursive: true });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Managed memory directory must not be a link.');
    this.index = store.memoryIndex();
    this.git = options.history?.(this.directory, options.warn ?? (() => {}));
    this.git?.ensureRepo();
    this.recover();
    this.git?.commitAll('Recover managed memory publications', MEMORY_AUTHOR);
  }

  private file(version: MemoryVersion): string {
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Managed memory directory must not be a link.');
    if (version.path !== `entries/${version.id}/${version.revision}.md` || !/^[0-9a-f-]{36}$/.test(version.id) || !Number.isSafeInteger(version.revision) || version.revision < 1) throw new Error('Invalid managed memory document path.');
    const file = resolve(this.directory, version.path);
    if (!file.startsWith(this.directory + sep)) throw new Error('Memory path escapes its directory.');
    let part = this.directory;
    for (const name of version.path.split('/')) {
      part = join(part, name);
      try { if (lstatSync(part).isSymbolicLink()) throw new Error('Memory documents must not follow links.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return file;
  }

  private document(version: MemoryVersion): string {
    const text = readFileSync(this.file(version), 'utf8');
    if (hash(text) !== version.hash) throw new Error('Memory document differs from its published hash; reconciliation is required.');
    return text;
  }

  private publish(version: MemoryVersion): void {
    if (version.published) { this.document(version); return; }
    const file = this.file(version);
    const document = version.pendingDocument!;
    if (hash(document) !== version.hash) throw new Error('Pending memory document checksum failed.');
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.tmp-${randomUUID()}`;
      const fd = openSync(temporary, 'wx');
      try { writeFileSync(fd, document, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, file);
    }
    this.document(version);
    this.index.publish(version, memoryTerms(version.title).join(' '), memoryTerms(bodyOf(document)).join(' '));
  }

  /** Checks an existing file before publishing; differing files are preserved for inspection. */
  recover(): void { for (const version of this.index.pending()) this.publish(version); }

  capture(event: SourceEvent): string { return this.store.recordSource(event); }

  sources(access: MemoryAccess, limit = 8): Array<{ id: string; source: string; occurredAt: string; scope: MemoryScope; text: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) throw new Error('Recent source limit must be between 1 and 8.');
    return this.store.sources(access.readScopes, limit).map(source => ({ id: source.id, source: source.source,
      occurredAt: source.occurredAt, scope: source.scope, text: String(source.payload.text ?? '').slice(0, 1000) }));
  }

  source(access: MemoryAccess, id: string, offset = 0) {
    const source = this.store.readSource(id);
    if (!source || !access.readScopes.includes(source.scope)) throw new Error('Source is unavailable.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Source offset must be a nonnegative integer.');
    const text = String(source.payload.text ?? '');
    return { id, scope: source.scope, source: source.source, key: source.key, occurredAt: source.occurredAt,
      cursor: source.payload.cursor ?? null, text: text.slice(offset, offset + 4000), totalChars: text.length,
      nextOffset: offset + 4000 < text.length ? offset + 4000 : null };
  }

  save(access: MemoryAccess, input: MemoryInput): Promise<{ memory: Omit<MemoryHit, 'excerpt'>; duplicate: boolean; gitVersioned: boolean }> {
    const run = async () => {
      validate(input);
      if (!access.readScopes.includes(access.writeScope)) throw new Error('Memory scope is not accessible.');
      const normalized = { ...input, title: input.title.trim(), text: input.text.trim(), sourceIds: [...new Set(input.sourceIds)].sort(),
        parents: [...(input.parents ?? [])].sort((a, b) => a.id.localeCompare(b.id)), status: input.status ?? 'active' as const,
        expectedRevision: input.expectedRevision ?? 0, scope: access.writeScope };
      const fingerprint = hash(JSON.stringify(normalized));
      const repeated = this.index.request(input.requestKey, fingerprint);
      if (repeated) {
        if (!access.readScopes.includes(repeated.scope) || repeated.scope !== access.writeScope) throw new Error('Memory is unavailable.');
        this.publish(repeated);
        await this.git?.commitAllAsync('Recover managed memory publication history', MEMORY_AUTHOR);
        const git = this.git?.status();
        return { memory: summary(repeated), duplicate: true, gitVersioned: !!git?.repo && !git.dirty && git.commitError === null };
      }
      this.recover();
      if (input.id && !this.index.find(input.id, [access.writeScope])) throw new Error('Memory is unavailable.');
      const id = input.id ?? randomUUID();
      const revision = normalized.expectedRevision + 1;
      const path = `entries/${id}/${revision}.md`;
      const header = { memory_id: id, revision, scope: normalized.scope, kind: normalized.kind, subject: normalized.subject,
        status: normalized.status, source_ids: normalized.sourceIds, parents: normalized.parents };
      const document = `---\n${Object.entries(header).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n# ${normalized.title}\n\n${normalized.text}\n`;
      const version = this.index.prepare({ ...normalized, id, fingerprint, path, hash: hash(document), document });
      this.publish(version);
      await this.git?.commitAllAsync(`Record memory ${id} revision ${revision}`, MEMORY_AUTHOR);
      const git = this.git?.status();
      return { memory: summary(version), duplicate: false, gitVersioned: !!git?.repo && !git.dirty && git.commitError === null };
    };
    const result = this.writes.then(run);
    this.writes = result.then(() => {}, () => {});
    return result;
  }

  read(access: MemoryAccess, id: string, revision?: number): MemoryHit & { document: string; historical: boolean } {
    const version = this.index.find(id, access.readScopes, revision);
    if (!version || !version.published) throw new Error('Memory is unavailable.');
    const document = this.document(version);
    return { ...summary(version), excerpt: bodyOf(document), document,
      historical: this.index.find(id, access.readScopes)?.revision !== version.revision };
  }

  search(access: MemoryAccess, query: string, maxChars = 4096): MemoryHit[] {
    if (typeof query !== 'string' || query.length > 512) throw new Error('Memory query must be at most 512 characters.');
    if (!Number.isSafeInteger(maxChars) || maxChars < 512 || maxChars > 16000) throw new Error('Memory context budget must be between 512 and 16000 characters.');
    const match = memoryTerms(query).slice(0, 48).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const hits: MemoryHit[] = [];
    let used = 2;
    for (const version of this.index.search(match, access.readScopes, 24)) {
      const body = bodyOf(this.document(version));
      const hit: MemoryHit = { ...summary(version), excerpt: '' };
      const overhead = JSON.stringify(hit).length + 1;
      if (used + overhead >= maxChars) break;
      hit.excerpt = body.slice(0, Math.min(1000, Math.floor((maxChars - used - overhead) / 2)));
      while (JSON.stringify(hit).length + used + 1 > maxChars) hit.excerpt = hit.excerpt.slice(0, -1);
      used += JSON.stringify(hit).length + 1;
      hits.push(hit);
    }
    return hits;
  }

  status(): { entries: number; pending: number; stale: number; directory: string; gitAvailable: boolean } {
    return { ...this.index.counts(), directory: this.directory, gitAvailable: this.git?.available() ?? false };
  }

  async flush(): Promise<void> { await this.writes; }
}
