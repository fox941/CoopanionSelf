import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Core } from 'cortico/core/core.ts';
import { loadDeployment } from 'cortico/deploy.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { createResponse } from 'cortico/protocol/open-responses/index.ts';
import { functionCall } from 'cortico/protocol/open-responses/context.ts';
import { unknownMeters, type ResponseClient } from 'cortico/core/generation.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { StateCoordinator } from '../core/friend/storage.ts';
import { MemoryService, DESKTOP_MEMORY_ACCESS, type MemoryAccess, type MemoryInput } from '../core/friend/memory-service.ts';
import { memoryTools } from '../core/friend/memory-tools.ts';
import { friendPersona } from '../core/friend-persona.ts';
import cormini from '../vendor/cortico/bots/cormini/index.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { WorkspaceGit } from '../vendor/cortico/bots/cormini/persona/workspaceGit.ts';

const roots: string[] = [];
const stores = new Set<StateCoordinator>();
const services: MemoryService[] = [];
const owner = DESKTOP_MEMORY_ACCESS;
const shared: MemoryAccess = { readScopes: ['shared'], writeScope: 'shared' };
function directory() { const dir = mkdtempSync(join(tmpdir(), 'friend-memory-')); roots.push(dir); return dir; }
function rig(dir = directory(), history = false) {
  const store = StateCoordinator.open(dir);
  stores.add(store);
  const memory = new MemoryService(store, history ? { history: (root, warn) => new WorkspaceGit(root, warn) } : {});
  services.push(memory);
  let sequence = 0;
  const evidence = (text = '用户说：我喜欢咖啡。', scope: MemoryAccess = owner) => memory.capture({ source: 'desktop',
    key: `fixture:${++sequence}`, scope: scope.writeScope, occurredAt: `2026-01-01T12:00:${String(sequence).padStart(2, '0')}Z`, payload: { text } });
  const input = (overrides: Partial<MemoryInput> = {}): MemoryInput => ({ requestKey: `fixture-write:${++sequence}`,
    title: '饮品偏好', text: '用户说自己喜欢咖啡。', kind: 'statement', subject: 'owner', sourceIds: [evidence()], ...overrides });
  return { dir, store, memory, evidence, input };
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.flush();
  for (const store of stores) store.close();
  stores.clear();
});
afterAll(() => {
  for (const dir of roots) {
    if (dirname(dir) !== tmpdir() || !dir.startsWith(join(tmpdir(), 'friend-memory-'))) throw new Error('Unexpected memory test directory.');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Managed memory', () => {
  it('keeps received statements separate from memories and leaves character state blank', () => {
    const r = rig();
    const source = r.evidence();
    expect(r.memory.sources(owner)[0]?.id).toBe(source);
    expect(r.memory.search(owner, '咖啡')).toEqual([]);
    expect(r.store.snapshot()).toMatchObject({ state: {}, revision: 0 });
  });

  it('publishes source-linked Markdown, searches Chinese phrases and stores real Git versions', async () => {
    const r = rig(undefined, true);
    const saved = await r.memory.save(owner, r.input());
    expect(saved.gitVersioned).toBe(true);
    const read = r.memory.read(owner, saved.memory.id);
    expect(read.document).toContain('source_ids:');
    expect(read.document).toContain('用户说自己喜欢咖啡');
    expect(read.sourceIds).toEqual(saved.memory.sourceIds);
    expect(r.memory.search(owner, '咖啡偏好').map(hit => hit.id)).toContain(saved.memory.id);
    expect(new WorkspaceGit(r.memory.directory).log({ limit: 5 }).some(commit => commit.message.includes(saved.memory.id))).toBe(true);
  });

  it('redelivers a tool receipt without duplicating memory or reviving an older correction', async () => {
    const r = rig();
    const first = r.input({ requestKey: 'stable-call' });
    const saved = await r.memory.save(owner, first);
    await r.memory.save(owner, r.input({ id: saved.memory.id, expectedRevision: 1, text: '用户更正：喜欢茶。' }));
    const repeated = await r.memory.save(owner, first);
    expect(repeated.duplicate).toBe(true);
    expect(repeated.memory.revision).toBe(1);
    expect(r.memory.read(owner, saved.memory.id)).toMatchObject({ revision: 2 });
    expect(r.memory.read(owner, saved.memory.id).excerpt).toContain('喜欢茶');
    expect(r.memory.status().entries).toBe(1);
    await expect(r.memory.save(owner, { ...first, text: 'Different content' })).rejects.toThrow('different content');
  });

  it('retains old revisions explicitly while removing corrected content from current retrieval', async () => {
    const r = rig();
    const saved = await r.memory.save(owner, r.input());
    await r.memory.save(owner, r.input({ id: saved.memory.id, expectedRevision: 1, text: '用户更正：喜欢茶，不喝前面说的饮料。' }));
    expect(r.memory.search(owner, '咖啡')).toEqual([]);
    expect(r.memory.read(owner, saved.memory.id, 1)).toMatchObject({ historical: true, revision: 1 });
    expect(r.memory.read(owner, saved.memory.id, 1).excerpt).toContain('咖啡');
  });

  it('invalidates dependent summaries recursively and requires current parent revisions', async () => {
    const r = rig();
    const parent = await r.memory.save(owner, r.input());
    const child = await r.memory.save(owner, r.input({ sourceIds: [], kind: 'inference', text: '因此可能喜欢咖啡馆。', parents: [{ id: parent.memory.id, revision: 1 }] }));
    const grandchild = await r.memory.save(owner, r.input({ sourceIds: [], text: '出行可以考虑咖啡馆。', parents: [{ id: child.memory.id, revision: 1 }] }));
    await r.memory.save(owner, r.input({ id: parent.memory.id, expectedRevision: 1, text: '刚才是假设，实际喜欢茶。' }));
    expect(r.memory.read(owner, child.memory.id).status).toBe('stale');
    expect(r.memory.read(owner, grandchild.memory.id).status).toBe('stale');
    expect(r.memory.search(owner, '咖啡')).toEqual([]);
    await expect(r.memory.save(owner, r.input({ sourceIds: [], parents: [{ id: parent.memory.id, revision: 1 }] }))).rejects.toThrow('current');
    await r.memory.save(owner, r.input({ id: child.memory.id, expectedRevision: 1, text: '原先的推断已不适用。', sourceIds: [], parents: [{ id: parent.memory.id, revision: 2 }] }));
    expect(r.memory.read(owner, child.memory.id).status).toBe('active');
    expect(r.memory.read(owner, grandchild.memory.id).status).toBe('stale');
  });

  it('rejects derivation cycles and stale concurrent revisions without losing the winning write', async () => {
    const r = rig();
    const parent = await r.memory.save(owner, r.input());
    const child = await r.memory.save(owner, r.input({ sourceIds: [], parents: [{ id: parent.memory.id, revision: 1 }] }));
    await expect(r.memory.save(owner, r.input({ id: parent.memory.id, expectedRevision: 1, sourceIds: [], parents: [{ id: child.memory.id, revision: 1 }] }))).rejects.toThrow('cycle');
    const results = await Promise.allSettled([
      r.memory.save(owner, r.input({ id: parent.memory.id, expectedRevision: 1, text: 'First correction.' })),
      r.memory.save(owner, r.input({ id: parent.memory.id, expectedRevision: 1, text: 'Obsolete correction.' })),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(r.memory.read(owner, parent.memory.id).excerpt).toContain('First correction');
  });

  it('filters sources, search and direct reads and prevents private evidence from becoming shared', async () => {
    const r = rig();
    const input = r.input();
    const saved = await r.memory.save(owner, input);
    expect(r.memory.sources(shared)).toEqual([]);
    expect(() => r.memory.source(shared, input.sourceIds[0]!)).toThrow('unavailable');
    expect(r.memory.search(shared, '咖啡')).toEqual([]);
    expect(() => r.memory.read(shared, saved.memory.id)).toThrow('unavailable');
    await expect(r.memory.save(shared, { ...input, requestKey: 'leaking-evidence' })).rejects.toThrow('scope');
    await expect(r.memory.save(shared, { ...input, requestKey: 'leaking-summary', sourceIds: [], parents: [{ id: saved.memory.id, revision: 1 }] })).rejects.toThrow('accessible');
    const source = r.evidence('公开活动：骑行。', shared);
    const publicMemory = await r.memory.save(shared, r.input({ sourceIds: [source], text: '公开活动是骑行。' }));
    expect(r.memory.search(owner, '骑行')[0]?.id).toBe(publicMemory.memory.id);
  });

  it('retrieves older evidence by id with bounded slices after it leaves the recent source list', () => {
    const r = rig();
    const text = '最初的一段陈述。'.repeat(700);
    const old = r.evidence(text);
    for (let i = 0; i < 12; i++) r.evidence(`后续陈述 ${i}`);
    expect(r.memory.sources(owner).some(source => source.id === old)).toBe(false);
    const first = r.memory.source(owner, old);
    const second = r.memory.source(owner, old, first.nextOffset!);
    expect(first.text + second.text).toBe(text);
    expect(second.nextOffset).toBe(null);
  });

  it('keeps a fictional parent from becoming factual evidence', async () => {
    const r = rig();
    const fiction = await r.memory.save(owner, r.input({ kind: 'fiction', subject: 'self', text: '一个梦境：在月球喝咖啡。' }));
    await expect(r.memory.save(owner, r.input({ sourceIds: [], kind: 'observation', parents: [{ id: fiction.memory.id, revision: 1 }] }))).rejects.toThrow('fiction');
  });

  it('retracts without deleting history or continuing to return the memory in search', async () => {
    const r = rig();
    const saved = await r.memory.save(owner, r.input());
    await r.memory.save(owner, r.input({ id: saved.memory.id, expectedRevision: 1, status: 'retracted', text: '用户撤回了这条陈述。' }));
    expect(r.memory.search(owner, '咖啡')).toEqual([]);
    expect(r.memory.read(owner, saved.memory.id).status).toBe('retracted');
    expect(r.memory.read(owner, saved.memory.id, 1).historical).toBe(true);
  });

  it('bounds recall output and treats query operators as ordinary text', async () => {
    const r = rig();
    for (let i = 0; i < 4; i++) await r.memory.save(owner, r.input({ text: '咖啡骑行'.repeat(300) }));
    expect(JSON.stringify(r.memory.search(owner, '咖啡', 700)).length).toBeLessThanOrEqual(700);
    expect(() => r.memory.search(owner, '咖啡 OR "* - ()')).not.toThrow();
    expect(r.memory.search(shared, 'OR *')).toEqual([]);
  });

  it('recovers a queued document after a real file-system write failure and restart', async () => {
    const r = rig();
    const blocker = join(r.memory.directory, 'entries');
    writeFileSync(blocker, 'A file prevents creation of the entries directory.');
    await expect(r.memory.save(owner, r.input())).rejects.toThrow();
    expect(r.memory.status()).toMatchObject({ entries: 1, pending: 1 });
    expect(r.memory.search(owner, '咖啡')).toEqual([]);
    r.store.close();
    unlinkSync(blocker);
    const restored = rig(r.dir);
    expect(restored.memory.status().pending).toBe(0);
    expect(restored.memory.search(owner, '咖啡')).toHaveLength(1);
  });

  it('accepts a matching already-written document but preserves a conflicting one for inspection', async () => {
    const r = rig();
    const blocker = join(r.memory.directory, 'entries');
    writeFileSync(blocker, 'block');
    await expect(r.memory.save(owner, r.input())).rejects.toThrow();
    const pending = r.store.memoryIndex().pending()[0]!;
    unlinkSync(blocker);
    const file = join(r.memory.directory, pending.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'An unexpected external edit.');
    expect(() => r.memory.recover()).toThrow('hash');
    expect(readFileSync(file, 'utf8')).toBe('An unexpected external edit.');
    expect(r.memory.status().pending).toBe(1);
    writeFileSync(file, pending.pendingDocument!);
    r.memory.recover();
    expect(r.memory.search(owner, '咖啡')).toHaveLength(1);
  });

  it('refuses changed published documents and preserves identity and history after a directory move', async () => {
    const r = rig();
    const saved = await r.memory.save(owner, r.input());
    const id = r.store.snapshot().profileId;
    r.store.close();
    const destination = directory();
    cpSync(r.dir, destination, { recursive: true });
    const restored = rig(destination);
    expect(restored.store.snapshot().profileId).toBe(id);
    expect(restored.memory.search(owner, '咖啡')[0]?.id).toBe(saved.memory.id);
    const version = restored.store.memoryIndex().find(saved.memory.id, owner.readScopes)!;
    writeFileSync(join(restored.memory.directory, version.path), 'Changed outside the managed tool.');
    expect(() => restored.memory.read(owner, saved.memory.id)).toThrow('hash');
    expect(() => restored.memory.search(owner, '咖啡')).toThrow('hash');
  });
});

describe('FriendPersona memory integration', () => {
  it('records memory through the real event loop with only model output scripted', async () => {
    const r = rig();
    const deployment = join(r.dir, 'home', 'companion');
    mkdirSync(join(deployment, 'providers', 'fixture'), { recursive: true });
    writeFileSync(join(deployment, 'providers', 'fixture', 'config.json'), JSON.stringify({ kind: 'openai-responses-compat', baseUrl: 'http://127.0.0.1:9/v1', spec: { model: 'fixture-model', thinking: false } }));
    writeFileSync(join(deployment, 'config.json'), JSON.stringify({ activeProvider: 'fixture' }));
    const loaded = loadDeployment(cormini, deployment, resolve(import.meta.dirname, '../vendor/cortico'));
    const Persona = friendPersona(Cormini);
    const persona = new Persona({ memoryDir: loaded.memoryDir, friend: { enabled: () => false, readSnapshot: () => null }, memoryService: () => r.memory });
    let calls = 0;
    const llm: ResponseClient = { respond: async (request, options) => {
      const response = createResponse(`response-fixture-${++calls}`, request);
      response.status = 'completed';
      const name = calls === 1 ? 'friend_memory_save' : 'end_turn';
      const args = calls === 1 ? { title: '共同话题', text: '用户说周末喜欢骑行。', kind: 'statement', subject: 'owner', source_ids: [r.memory.sources(owner)[0]!.id] } : {};
      response.output = [functionCall(`fixture-loop-${calls}`, name, JSON.stringify(args)).item as never];
      options?.onEvent?.({ type: 'response.completed', response, sequence_number: 0 });
      const origin = { instance: 'fixture', module: 'fixture', model: 'fixture-model', compatibilityDomain: 'fixture' };
      return { response, origin, attempts: [{ id: `attempt-${calls}`, generationId: response.id, ordinal: 0, origin,
        startedAt: new Date().toISOString(), elapsedMs: 0, requestId: null, responseId: response.id,
        outcome: 'completed', status: 200, serviceTier: 'default', meters: unknownMeters(), charges: [] }] };
    } };
    const core = new Core(loaded, { persona, worlds: [], llm });
    try {
      await core.start();
      const event = core.store.append({ source: 'desktop-pet', type: 'desktop-pet.message', origin: 'external', ts: '2026-01-01T00:00:00Z', text: '周末喜欢骑行。', meta: { text: '周末喜欢骑行。' } });
      core.bus.push({ event }, { trigger: 'preempt' });
      const deadline = Date.now() + 4000;
      while (calls < 2 || r.memory.status().entries === 0) {
        if (Date.now() > deadline) throw new Error('Managed memory did not complete its real event-loop turn.');
        await delay(10);
      }
      expect(r.memory.search(owner, '骑行')).toHaveLength(1);
      expect(JSON.stringify(core.session.records)).toContain('friend_memory_save');
      expect(JSON.stringify(core.loop.outboundMessages())).toContain('msg_friend_memory');
    } finally { await core.stop(); }
  });

  it('captures desktop evidence, exposes managed tools and recalls through real Core request context across restart', async () => {
    const r = rig();
    const deployment = join(r.dir, 'home', 'companion');
    mkdirSync(deployment, { recursive: true });
    const loaded = loadDeployment(cormini, deployment, resolve(import.meta.dirname, '../vendor/cortico'));
    const Persona = friendPersona(Cormini);
    const persona = new Persona({ memoryDir: loaded.memoryDir, friend: { enabled: () => false, readSnapshot: () => null }, memoryService: () => r.memory });
    const core = new Core(loaded, { persona, worlds: [] });
    try {
      const event = { cursor: 1, source: 'desktop-pet', type: 'desktop-pet.message', origin: 'external' as const,
        ts: '2026-01-01T00:00:00Z', text: '[typed] 我喜欢周末骑行。', meta: { text: '我喜欢周末骑行。' } };
      persona.onDelivery({ events: [event] });
      persona.onDelivery({ events: [event] });
      expect(r.memory.sources(owner)).toHaveLength(1);
      const tools = persona.declareSessions().find(session => session.persistent && session.receivesEvents)!.tools();
      const source = r.memory.sources(owner)[0]!;
      const result = await tools.find(tool => tool.name === 'friend_memory_save')!.handler({
        title: '周末活动', text: '用户说喜欢周末骑行。', kind: 'statement', subject: 'owner', source_ids: [source.id],
      }, { role: 'main', callId: 'fixture-call', log: nullLogger() });
      expect(typeof result).toBe('string');
      const history = JSON.stringify(core.session.records);
      const first = JSON.stringify(core.loop.outboundMessages());
      expect(first).toContain('周末骑行');
      expect(first).toContain('msg_friend_memory');
      expect(JSON.stringify(core.session.records)).toBe(history);
      expect(history).not.toContain('msg_friend_memory');
      await r.memory.flush();
      const restarted = new Persona({ memoryDir: loaded.memoryDir, friend: { enabled: () => false, readSnapshot: () => null }, memoryService: () => r.memory });
      expect(JSON.stringify(restarted.sessionHead())).toContain('周末骑行');
      expect(readFileSync(join(loaded.memoryDir, 'CONSTITUTION.md'), 'utf8')).toBe('');
      expect(readFileSync(join(loaded.memoryDir, 'SYSTEM.md'), 'utf8')).toBe('');
      persona.onDelivery({ events: [{ ...event, cursor: 2, source: 'unbound-world' }] });
      expect(JSON.stringify(persona.sessionHead())).not.toContain('周末骑行');
      const denied = await tools.find(tool => tool.name === 'friend_memory_search')!.handler({ query: '骑行' }, { role: 'main', log: nullLogger() });
      expect(denied).toMatchObject({ failed: true });
    } finally { await core.stop(); }
  });

  it('rejects unsupported sessions and missing call ids without writing a memory', async () => {
    const r = rig();
    const tools = memoryTools(() => r.memory, () => owner);
    const save = tools.find(tool => tool.name === 'friend_memory_save')!;
    expect(await save.handler({}, { role: 'other', callId: 'other-call', log: nullLogger() })).toMatchObject({ failed: true });
    expect(await save.handler({}, { role: 'main', log: nullLogger() })).toMatchObject({ failed: true });
    expect(r.memory.status().entries).toBe(0);
  });
});
