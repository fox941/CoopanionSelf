/** A self-authored character over Coopanion's workspace, with optional current-state context. */
import { join } from 'node:path';
import type { Language } from 'cortico/core/language.ts';
import type { PersonaWebUiDecl, PrefixSegment, SessionOpeningReason, SystemPrefixContext, ToolDef } from 'cortico/core/types.ts';
import type { Item } from 'cortico/protocol/open-responses/context.ts';
import type { Cormini, CorminiOptions } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { PARTNER_FILE, coopanionPersona } from './persona.ts';
import { FRIEND_CONTEXT_MAX_CHARS, type FriendContextSource } from './friend/context.ts';
import { SELF_RUNTIME_TEXT, friendContextText } from './friend/model-text.ts';
import { SELF_SYSTEM_FILE, ensureSelfPrompts, readSelfPrompt } from './friend/self-prompts.ts';

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'delete_file', 'move_file']);

export interface FriendPersonaOptions extends CorminiOptions {
  friend: FriendContextSource;
  /** Schedules a Core prefix rebuild at its safe batch boundary; never awaited inside a tool. */
  refreshPrefix?: () => Promise<void>;
}

export function friendPersona(Base: typeof Cormini) {
  return class FriendPersona extends coopanionPersona(Base) {
    private readonly friend: FriendContextSource;
    private readonly refreshPrefix: (() => Promise<void>) | undefined;
    private refreshPending = false;

    constructor(opts: FriendPersonaOptions) {
      super({ ...opts, seedConstitution: '', orientation: undefined, orientationFile: undefined, orientationOverrideFile: undefined });
      ensureSelfPrompts(this.memoryDir);
      this.friend = opts.friend;
      this.refreshPrefix = opts.refreshPrefix;
    }

    protected override orientationSource(): string {
      return join(this.memoryDir, SELF_SYSTEM_FILE);
    }

    protected override memoryNote(): string { return ''; }

    protected override partnerDoc(): string {
      return readSelfPrompt(this.memoryDir, PARTNER_FILE).trim();
    }

    override async systemSegments(ctx: SystemPrefixContext): Promise<PrefixSegment[]> {
      return [{ title: 'RUNTIME', text: SELF_RUNTIME_TEXT }, ...await super.systemSegments(ctx)];
    }

    override webUi(language: Language = 'zh'): PersonaWebUiDecl {
      const page = super.webUi(language);
      return { ...page, promptDocs: page.promptDocs?.map(doc => doc.key === 'orientation' ? { ...doc, title: SELF_SYSTEM_FILE } : doc) };
    }

    override onOpening(ctx: { reason: SessionOpeningReason }): void {
      if (ctx.reason !== 'new') super.onOpening(ctx);
    }

    protected override prefixResidentFiles(): string[] {
      return [...super.prefixResidentFiles(), join(this.memoryDir, SELF_SYSTEM_FILE)];
    }

    private promptContents(): string {
      return JSON.stringify(['CONSTITUTION.md', SELF_SYSTEM_FILE, PARTNER_FILE].map(name => readSelfPrompt(this.memoryDir, name)));
    }

    protected override tools(): ToolDef[] {
      return super.tools().map(tool => !WRITE_TOOLS.has(tool.name) ? tool : {
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
    }

    override sessionHead(): Item[] {
      const head = super.sessionHead();
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
