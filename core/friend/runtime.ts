/** Opens companion storage after Core owns its deployment lock and closes it with the run. */
import { resolve } from 'node:path';
import { FRIEND_SCHEMA_VERSION } from './schema.ts';
import { StateCoordinator } from './storage.ts';
import { MemoryService, type MemoryHistoryFactory } from './memory-service.ts';

export class FriendStorageRuntime {
  private store: StateCoordinator | null = null;
  private memory: MemoryService | null = null;

  constructor(private readonly runtimeRoot: string, private readonly history?: MemoryHistoryFactory) {}

  start(): StateCoordinator {
    if (this.store) return this.store;
    const store = StateCoordinator.open(this.runtimeRoot);
    try { this.memory = new MemoryService(store, { history: this.history, warn: message => console.warn('[friend-memory]', message) }); }
    catch (error) { store.close(); throw error; }
    return this.store = store;
  }

  memories(): MemoryService | null { return this.memory; }

  async flush(): Promise<void> { await this.memory?.flush(); }

  status() {
    const snapshot = this.store?.snapshot();
    return {
      ready: this.store !== null, databasePath: resolve(this.runtimeRoot, 'friend', 'friend.sqlite'),
      schemaVersion: FRIEND_SCHEMA_VERSION, profileId: snapshot?.profileId ?? null, revision: snapshot?.revision ?? null,
      memory: this.memory?.status() ?? null,
    };
  }

  stop(): void {
    this.store?.close();
    this.store = null;
    this.memory = null;
  }
}
