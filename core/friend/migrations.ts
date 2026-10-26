/** The caller holds one startup transaction across schema changes and character initialization. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { FRIEND_APPLICATION_ID, FRIEND_MIGRATIONS } from './schema.ts';

export interface FriendMigration { readonly version: number; readonly sql: string }

export function applyFriendMigrations(
  db: DatabaseSync,
  options: { fresh: boolean; now: string },
  migrations: readonly FriendMigration[] = FRIEND_MIGRATIONS,
): void {
  const application = db.prepare('PRAGMA application_id').get()!.application_id as number;
  const version = db.prepare('PRAGMA user_version').get()!.user_version as number;
  const supported = migrations.at(-1)!.version;
  if (version > supported) throw new Error('Friend database requires a newer application; restore a compatible program version.');
  if (version === 0) {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    if (!options.fresh || application !== 0 || tables.length) throw new Error('Existing friend database has no recognized schema; automatic reinitialization is disabled.');
  } else if (application !== FRIEND_APPLICATION_ID) {
    throw new Error('The selected file is not a friend database.');
  }
  const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');
  const applied = version === 0 ? [] : db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
  if (applied.length !== version || applied.some((row, index) => row.version !== index + 1 || row.checksum !== checksum(migrations[index].sql))) {
    throw new Error('Friend schema migration history does not match this application.');
  }
  for (const migration of migrations.filter(entry => entry.version > version)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, checksum(migration.sql), options.now);
    db.exec(`PRAGMA user_version = ${migration.version};`);
  }
  if (version === 0) db.exec(`PRAGMA application_id = ${FRIEND_APPLICATION_ID};`);
}
