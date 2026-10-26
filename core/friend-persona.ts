/** Coopanion's Persona with one current state snapshot in the nonpersistent session head. */
import type { Item } from 'cortico/protocol/open-responses/context.ts';
import type { Cormini, CorminiOptions } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { coopanionPersona } from './persona.ts';
import { FRIEND_CONTEXT_MAX_CHARS, type FriendContextSource } from './friend/context.ts';
import { friendContextText } from './friend/model-text.ts';

export interface FriendPersonaOptions extends CorminiOptions {
  friend: FriendContextSource;
}

export function friendPersona(Base: typeof Cormini) {
  return class FriendPersona extends coopanionPersona(Base) {
    private readonly friend: FriendContextSource;

    constructor(opts: FriendPersonaOptions) {
      super(opts);
      this.friend = opts.friend;
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
