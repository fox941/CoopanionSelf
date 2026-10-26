import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Core } from 'cortico/core/core.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { loadDeployment } from 'cortico/deploy.ts';
import cormini from '../vendor/cortico/bots/cormini/index.ts';
import { Cormini, CORMINI_CONTEXT_DEFAULTS, FIRST_TURN_FILES } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { friendPersona } from '../core/friend-persona.ts';
import { FRIEND_CONTEXT_MAX_CHARS, previewFriendContext } from '../core/friend/context.ts';
import { coopanionPersona } from '../core/persona.ts';

const FriendPersona = friendPersona(Cormini);
const CoopanionPersona = coopanionPersona(Cormini);
const dirs: string[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'friend-persona-'));
  dirs.push(dir);
  const previewDir = join(dir, 'friend');
  mkdirSync(previewDir);
  const firstTurnDir = join(dir, 'prompts');
  mkdirSync(firstTurnDir);
  writeFileSync(join(firstTurnDir, FIRST_TURN_FILES.user), 'Hello.');
  writeFileSync(join(firstTurnDir, FIRST_TURN_FILES.reply), 'Good to see you.');
  const opts = {
    memoryDir: join(dir, 'workspace'), firstTurnDir,
    context: () => ({ ...CORMINI_CONTEXT_DEFAULTS, firstTurn: true }),
  };
  const source = previewFriendContext(dir);
  const persona = new FriendPersona({ ...opts, friend: source });
  const write = (revision: number, content: string) => writeFileSync(join(previewDir, 'context-preview.json'), JSON.stringify({ revision, content }));
  return { dir, source, persona, write, base: new CoopanionPersona(opts) };
}

afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  for (const dir of dirs) {
    if (dirname(dir) !== tmpdir() || !dir.startsWith(join(tmpdir(), 'friend-persona-'))) throw new Error('Unexpected test directory.');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('FriendPersona context', () => {
  it('leaves the original head intact when disabled, even if the preview is invalid', () => {
    vi.stubEnv('COOPANION_FRIEND_ENABLED', '0');
    const rig = setup();
    writeFileSync(join(rig.dir, 'friend/context-preview.json'), 'invalid JSON');
    expect(rig.persona.sessionHead()).toEqual(rig.base.sessionHead());
  });

  it('reads changed state on the next request and keeps unchanged request context stable', () => {
    vi.stubEnv('COOPANION_FRIEND_ENABLED', '1');
    const rig = setup();
    rig.write(1, 'Development preview: rested.');
    const first = rig.persona.sessionHead();
    expect(rig.persona.sessionHead()).toEqual(first);
    expect(first.slice(0, -1)).toEqual(rig.base.sessionHead());
    expect(JSON.stringify(first)).toContain('Development preview: rested.');
    rig.write(2, 'Development preview: tired.');
    const next = rig.persona.sessionHead();
    expect(next).toHaveLength(first.length);
    expect(next.at(-1)?.id).toBe(first.at(-1)?.id);
    expect(JSON.stringify(next)).toContain('Development preview: tired.');
    expect(JSON.stringify(next)).not.toContain('Development preview: rested.');
    vi.stubEnv('COOPANION_FRIEND_ENABLED', '0');
    expect(rig.persona.sessionHead()).toEqual(rig.base.sessionHead());
  });

  it('omits missing or malformed state while preserving the base context', () => {
    vi.stubEnv('COOPANION_FRIEND_ENABLED', '1');
    const rig = setup();
    expect(rig.persona.sessionHead()).toEqual(rig.base.sessionHead());
    rig.write(1, 'Development preview: rested.');
    expect(rig.persona.sessionHead().length).toBeGreaterThan(rig.base.sessionHead().length);
    writeFileSync(join(rig.dir, 'friend/context-preview.json'), '{');
    expect(rig.persona.sessionHead()).toEqual(rig.base.sessionHead());
  });

  it.each([
    { label: 'negative revision', snapshot: { revision: -1, content: 'test' } },
    { label: 'fractional revision', snapshot: { revision: 1.5, content: 'test' } },
    { label: 'blank content', snapshot: { revision: 1, content: ' ' } },
    { label: 'oversized content', snapshot: { revision: 1, content: 'x'.repeat(FRIEND_CONTEXT_MAX_CHARS + 1) } },
  ])('rejects $label at the input boundary', ({ snapshot }) => {
    const rig = setup();
    writeFileSync(join(rig.dir, 'friend/context-preview.json'), JSON.stringify(snapshot));
    expect(() => rig.source.readSnapshot()).toThrow();
  });

  it('rejects oversized files before parsing their contents', () => {
    const rig = setup();
    writeFileSync(join(rig.dir, 'friend/context-preview.json'), ' '.repeat(33 * 1024));
    expect(() => rig.source.readSnapshot()).toThrow('file size limit');
  });

  it('keeps workspace writes and one persistent event session while the preview stays outside file tools', async () => {
    vi.stubEnv('COOPANION_FRIEND_ENABLED', '1');
    const rig = setup();
    rig.write(1, 'Development preview: private application context.');
    const sessions = rig.persona.declareSessions();
    const mains = sessions.filter(session => session.persistent && session.receivesEvents);
    expect(mains).toHaveLength(1);
    const tools = mains[0]!.tools();
    const context = { role: 'main', log: nullLogger() } as never;
    const run = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.handler(args, context);
    await run('write_file', { path: 'notes/hello.md', content: 'A shared experience.' });
    expect(readFileSync(join(rig.persona.memoryDir, 'notes/hello.md'), 'utf8')).toBe('A shared experience.');
    expect(String(await run('read_file', { path: '../friend/context-preview.json' }))).not.toContain('private application context');
    expect(rig.source.readSnapshot()?.content).toContain('private application context');
  });

  it('adds only the current snapshot to real Core request context without appending it to history', async () => {
    vi.stubEnv('COOPANION_FRIEND_ENABLED', '1');
    const rig = setup();
    mkdirSync(join(rig.dir, 'providers/fixture'), { recursive: true });
    writeFileSync(join(rig.dir, 'providers/fixture/config.json'), JSON.stringify({ kind: 'openai-responses-compat', baseUrl: 'http://127.0.0.1:9/v1', spec: { model: 'test-model', thinking: false } }));
    writeFileSync(join(rig.dir, 'config.json'), JSON.stringify({ activeProvider: 'fixture' }));
    const loaded = loadDeployment(cormini, rig.dir, resolve(import.meta.dirname, '../vendor/cortico'));
    const core = new Core(loaded, { persona: rig.persona, worlds: [] });
    try {
      rig.write(1, 'Development preview: rested.');
      const initial = core.loop.outboundMessages();
      expect(initial.some(record => record.context.head && JSON.stringify(record.item).includes('Development preview: rested.'))).toBe(true);
      const history = JSON.stringify(core.session.records);
      rig.write(2, 'Development preview: tired.');
      const next = core.loop.outboundMessages();
      expect(JSON.stringify(next)).toContain('Development preview: tired.');
      expect(JSON.stringify(next)).not.toContain('Development preview: rested.');
      expect(JSON.stringify(core.session.records)).toBe(history);
      expect(history).not.toContain('Development preview:');
    } finally {
      await core.stop();
    }
  });
});
