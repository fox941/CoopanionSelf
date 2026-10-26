/** Read-only context supplied to FriendPersona; persistent state will own this interface. */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface FriendContextSnapshot {
  revision: number;
  content: string;
}

export interface FriendContextSource {
  enabled(): boolean;
  readSnapshot(): FriendContextSnapshot | null;
}

export const FRIEND_CONTEXT_MAX_CHARS = 4096;
const PREVIEW_MAX_BYTES = 32 * 1024;

/** Development input outside the model's workspace; never seeds or writes a character state. */
export function previewFriendContext(deploymentDir: string): FriendContextSource {
  const file = join(deploymentDir, 'friend', 'context-preview.json');
  return {
    enabled: () => process.env.COOPANION_FRIEND_ENABLED === '1',
    readSnapshot: () => {
      let source: string;
      try {
        if (statSync(file).size > PREVIEW_MAX_BYTES) throw new Error('Friend context preview exceeds the file size limit.');
        source = readFileSync(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      let snapshot: unknown;
      try { snapshot = JSON.parse(source); }
      catch { throw new Error('Friend context preview contains invalid JSON.'); }
      if (snapshot === null || typeof snapshot !== 'object') throw new Error('Friend context preview must be an object.');
      const { revision, content } = snapshot as Record<string, unknown>;
      if (!Number.isSafeInteger(revision) || (revision as number) < 0
        || typeof content !== 'string' || !content.trim() || content.length > FRIEND_CONTEXT_MAX_CHARS) {
        throw new Error('Friend context preview requires a nonnegative revision and bounded, nonempty content.');
      }
      return { revision: revision as number, content };
    },
  };
}
