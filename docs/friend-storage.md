<!-- Owner: core/friend/storage.ts, core/friend/migrations.ts, core/friend/schema.ts, core/friend/runtime.ts -->

# Companion storage

The app opens `<runtime>/friend/friend.sqlite` through `FriendStorageRuntime` after Core acquires its deployment lock and before event delivery starts. Its runtime root is the parent of the app's `CORTICO_HOME` (`<runtime>/home`). For the local development launcher this is `D:\ai friend\runtime\dev`. The database uses the runtime's built-in `node:sqlite`; it adds no native package dependency. `scripts/pack.ts` already copies `core/`, including these modules.

## Character and schema

`profile_state` contains one stable UUID, revision zero and an empty JSON object at initialization. It assigns no name, personality, emotional disposition, relationship or energy value. Existing workspace prompts, provider configuration and Cortico records are preserved. Copying a stopped runtime directory preserves the UUID.

`schema_migrations` records each immutable SQL migration's checksum and application time. Schema changes and first identity creation run in one transaction. Append migrations in order and advance `FRIEND_SCHEMA_VERSION`; never rewrite an applied migration. An unsupported newer version, changed migration, missing identity, unrecognized existing file or corruption fails startup. No empty replacement character is created.

The database has an application ID, strict tables, JSON checks, foreign keys, WAL and `synchronous=FULL`. A second lock in the `friend/` directory reuses Cortico's instance-lock implementation and rejects a second writer even if the outer deployment lock was bypassed. `close()` releases the connection and its lock. SQLite access is synchronous and transactions contain no model calls, network work or `await`.

## Sources and state

`recordSource()` stores an envelope with its source, source-local event key, visibility scope, occurrence time, receipt time and JSON payload. The envelope establishes what was received; a statement inside its payload is not certified as true. Reusing a source key with different content, occurrence time or scope fails. Canonical JSON makes object property order irrelevant.

`apply()` accepts an application-owned consumer ID, source envelope, expected state revision, complete next state, brief reason and optional pending operations. Source insertion, state revision, change history, consumer receipt and operations commit together. Failure rolls them all back. Redelivery returns the first receipt and current state without applying the old change again. A different consumer can process the same source. A stale expected revision fails so the caller can merge against a fresh snapshot.

These are storage APIs for the assembly and future Persona services. They do not expose SQL to the model. Scope labels are recorded here; identity binding, scoped memory retrieval and managed workspace tools are separate work. Business state validators and emotion dynamics have not been implemented.

## Recoverable work

Operations have stable IDs and states `pending`, `running`, `completed` and `uncertain`. Claiming pending work returns a new token; completion requires that token. A restarted store marks unfinished running work uncertain. It is not automatically repeated. The caller must establish the external result and either record it or explicitly allow a retry. State changes can enqueue work but do not execute it inside the transaction.

The outbox currently supplies persistence and reconciliation primitives. Document projection workers, activity executors and platform sending are not connected.

## Backups and inspection

`backupTo(destination)` creates a new database-only snapshot using `VACUUM INTO`, includes committed WAL data and syncs the output file. It refuses an existing destination. A full character backup also needs the workspace, its Git history, Cortico event/session files, configuration and required extension data. Whole-runtime export/import tooling is still planned. During a manual migration stop both instances and copy the complete runtime into a separate destination before starting it.

The existing `/api/status` response includes `friendStorage`: readiness, absolute database path, supported schema version, character UUID and current revision. It includes no state payload or credentials. The database is independent of the optional development context preview. It does not yet inject learned state, memories or reflections into model requests.

`tests/friend-storage.test.ts` exercises real SQLite transactions, migration success and rollback, redelivery, stale revisions, writer exclusion, operation reconciliation, database snapshots, directory copying and a real Core lifecycle. Its profiles are isolated. The Vitest 2 module resolver loads the actual `node:sqlite` binding through a test-only shim because its built-in list predates that module.
