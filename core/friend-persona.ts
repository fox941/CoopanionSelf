/** A self-authored character over Coopanion's workspace, with optional current-state context. */
import { join } from 'node:path';
import type { Language } from 'cortico/core/language.ts';
import type { EventEnvelope, PersonaWebUiDecl, PrefixSegment, SessionOpeningReason, SystemPrefixContext, ToolDef } from 'cortico/core/types.ts';
import type { Item } from 'cortico/protocol/open-responses/context.ts';
import type { Cormini, CorminiOptions } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { PARTNER_FILE, coopanionPersona } from './persona.ts';
import { FRIEND_CONTEXT_MAX_CHARS, type FriendContextSource } from './friend/context.ts';
import { SELF_RUNTIME_TEXT, friendContextText } from './friend/model-text.ts';
import { SELF_SYSTEM_FILE, ensureSelfPrompts, readSelfPrompt } from './friend/self-prompts.ts';
import { DESKTOP_MEMORY_ACCESS, type MemoryAccess, type MemoryService } from './friend/memory-service.ts';
import { memoryTools } from './friend/memory-tools.ts';
import { MANAGED_MEMORY_TEXT, memoryContextText } from './friend/model-text.ts';

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'delete_file', 'move_file']);

export interface FriendPersonaOptions extends CorminiOptions {
  friend: FriendContextSource;
  /** Schedules a Core prefix rebuild at its safe batch boundary; never awaited inside a tool. */
  refreshPrefix?: () => Promise<void>;
  memoryService?: () => MemoryService | null;
}

export function friendPersona(Base: typeof Cormini) {
  return class FriendPersona extends coopanionPersona(Base) {
    private readonly friend: FriendContextSource;
    private readonly refreshPrefix: (() => Promise<void>) | undefined;
    private refreshPending = false;
    private readonly managedMemory: (() => MemoryService | null) | undefined;
    private memoryAccess: MemoryAccess | null = DESKTOP_MEMORY_ACCESS;
    private memoryQuery = '';

    constructor(opts: FriendPersonaOptions) {
      super({ ...opts, seedConstitution: '', orientation: undefined, orientationFile: undefined, orientationOverrideFile: undefined });
      ensureSelfPrompts(this.memoryDir);
      this.friend = opts.friend;
      this.refreshPrefix = opts.refreshPrefix;
      this.managedMemory = opts.memoryService;
    }

    protected override orientationSource(): string {
      return join(this.memoryDir, SELF_SYSTEM_FILE);
    }

    protected override memoryNote(): string { return ''; }

    protected override partnerDoc(): string {
      return readSelfPrompt(this.memoryDir, PARTNER_FILE).trim();
    }

    override async systemSegments(ctx: SystemPrefixContext): Promise<PrefixSegment[]> {
      return [{ title: 'RUNTIME', text: SELF_RUNTIME_TEXT + (this.managedMemory ? '\n\n' + MANAGED_MEMORY_TEXT : '') }, ...await super.systemSegments(ctx)];
    }

    override webUi(language: Language = 'zh'): PersonaWebUiDecl {
      const page = super.webUi(language);
      return { ...page, promptDocs: page.promptDocs?.map(doc => doc.key === 'orientation' ? { ...doc, title: SELF_SYSTEM_FILE } : doc) };
    }

    override onOpening(ctx: { reason: SessionOpeningReason }): void {
      if (ctx.reason !== 'new') super.onOpening(ctx);
    }

    override onDelivery(ctx: { events: EventEnvelope[] }): void {
      super.onDelivery(ctx);
      const external = ctx.events.filter(event => event.origin === 'external');
      if (!external.length) return;
      const desktop = external.filter(event => event.source === 'desktop-pet' && ['desktop-pet.message', 'desktop-pet.speech'].includes(event.type));
      // Other Worlds need trusted identity binding and a separate conversation before memory access.
      if (external.some(event => event.source !== 'desktop-pet')) this.memoryAccess = null;
      else if (desktop.length) this.memoryAccess = DESKTOP_MEMORY_ACCESS;
      if (!this.memoryAccess) return;
      const memory = this.managedMemory?.();
      if (!memory) return;
      for (const event of desktop) {
        const text = typeof event.meta?.text === 'string' ? event.meta.text : event.text;
        memory.capture({ source: 'desktop', key: `cortico:${event.cursor}`, scope: 'owner_private', occurredAt: event.ts,
          payload: { text, renderedText: event.text, eventType: event.type, eventSource: event.source, cursor: event.cursor } });
        this.memoryQuery = text.slice(0, 512);
      }
    }

    protected override prefixResidentFiles(): string[] {
      return [...super.prefixResidentFiles(), join(this.memoryDir, SELF_SYSTEM_FILE)];
    }

    private promptContents(): string {
      return JSON.stringify(['CONSTITUTION.md', SELF_SYSTEM_FILE, PARTNER_FILE].map(name => readSelfPrompt(this.memoryDir, name)));
    }

    protected override tools(): ToolDef[] {
      const workspace = super.tools().map<ToolDef>(tool => !WRITE_TOOLS.has(tool.name) ? tool : {
        ...tool,
        handler: async (args, ctx) => {
          const before = this.promptContents();
          const result = await tool.handler(args, ctx);
          if (before !== this.promptContents() && this.refreshPrefix && !this.refreshPending) {
            this.refreshPending = true;
            void this.refreshPrefix().catch(() => {
              this.core?.log.warn('Self-authored prompt reload failed; workspace changes remain saved.');
            }).finally(() => { this.refreshPending = false; });
          }
          return result;
        },
      });
      return this.managedMemory ? [...workspace, ...memoryTools(this.managedMemory, () => this.memoryAccess)] : workspace;
    }

    override sessionHead(): Item[] {
      const head = super.sessionHead();
      const memory = this.managedMemory?.();
      if (memory && this.memoryAccess) {
        try {
          const sources = memory.sources(this.memoryAccess, 3);
          const query = this.memoryQuery || sources[0]?.text.slice(0, 512) || '';
          const related = memory.search(this.memoryAccess, query, 3500);
          if (sources.length || related.length) head.push({
            type: 'message', id: 'msg_friend_memory', status: 'completed', role: 'user',
            content: [{ type: 'input_text', text: memoryContextText(sources, related) }],
          });
        } catch {
          this.core?.log.warn('Managed memory context could not be read; use the memory tools to inspect it.');
        }
      }
      if (!this.friend.enabled()) return head;
      try {
        const snapshot = this.friend.readSnapshot();
        if (!snapshot) return head;
        if (snapshot.content.length > FRIEND_CONTEXT_MAX_CHARS) throw new Error('Friend context exceeds the character limit.');
        return [...head, {
          type: 'message', id: 'msg_friend_context', status: 'completed', role: 'user',
          content: [{ type: 'input_text', text: friendContextText(snapshot) }],
        }];
      } catch {
        this.core?.log.warn('Friend context could not be read; this request uses the base session head.');
        return head;
      }
    }
  };
}
