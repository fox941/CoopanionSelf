/** Opens companion storage after Core owns its deployment lock and closes it with the run. */
import { resolve } from 'node:path';
import { FRIEND_SCHEMA_VERSION } from './schema.ts';
import { StateCoordinator } from './storage.ts';

export class FriendStorageRuntime {
  private store: StateCoordinator | null = null;

  constructor(private readonly runtimeRoot: string) {}

  start(): StateCoordinator {
    return this.store ??= StateCoordinator.open(this.runtimeRoot);
  }

  status(): { ready: boolean; databasePath: string; schemaVersion: number; profileId: string | null; revision: number | null } {
    const snapshot = this.store?.snapshot();
    return {
      ready: this.store !== null, databasePath: resolve(this.runtimeRoot, 'friend', 'friend.sqlite'),
      schemaVersion: FRIEND_SCHEMA_VERSION, profileId: snapshot?.profileId ?? null, revision: snapshot?.revision ?? null,
    };
  }

  stop(): void {
    this.store?.close();
    this.store = null;
  }
}
