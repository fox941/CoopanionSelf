/** Versioned schema for the companion's state, source events and recoverable local work. */
export const FRIEND_APPLICATION_ID = 0x46524e44;
export const FRIEND_SCHEMA_VERSION = 2;

export const INITIAL_SCHEMA = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE profile_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  profile_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_type(state_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE source_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  fingerprint TEXT NOT NULL,
  UNIQUE (source, event_key)
) STRICT;
CREATE INDEX source_events_time ON source_events(received_at, id);

CREATE TABLE processed_events (
  consumer TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES source_events(id),
  applied_revision INTEGER NOT NULL,
  PRIMARY KEY (consumer, source_event_id)
) STRICT;

CREATE TABLE state_changes (
  revision INTEGER PRIMARY KEY CHECK (revision > 0),
  source_event_id TEXT NOT NULL REFERENCES source_events(id),
  consumer TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_type(state_json) = 'object'),
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (consumer, source_event_id)
) STRICT;

CREATE TABLE outbox (
  operation_id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL REFERENCES source_events(id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token TEXT,
  result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'running') = (claim_token IS NOT NULL))
) STRICT;
CREATE INDEX outbox_pending ON outbox(status, created_at, operation_id);
`;

export const MEMORY_SCHEMA = `
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'stale', 'retracted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE memory_versions (
  memory_id TEXT NOT NULL REFERENCES memory_entries(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  request_key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('statement', 'observation', 'reflection', 'inference', 'fiction', 'commitment')),
  subject TEXT NOT NULL CHECK (subject IN ('owner', 'self', 'other')),
  status TEXT NOT NULL CHECK (status IN ('active', 'retracted')),
  document_path TEXT NOT NULL UNIQUE,
  document_hash TEXT NOT NULL,
  pending_document TEXT,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, revision),
  CHECK ((published = 0 AND pending_document IS NOT NULL) OR (published = 1 AND pending_document IS NULL))
) STRICT;
CREATE TABLE memory_evidence (
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES source_events(id),
  PRIMARY KEY (memory_id, revision, source_event_id),
  FOREIGN KEY (memory_id, revision) REFERENCES memory_versions(memory_id, revision)
) STRICT;
CREATE TABLE memory_links (
  child_id TEXT NOT NULL,
  child_revision INTEGER NOT NULL,
  parent_id TEXT NOT NULL,
  parent_revision INTEGER NOT NULL,
  PRIMARY KEY (child_id, child_revision, parent_id),
  FOREIGN KEY (child_id, child_revision) REFERENCES memory_versions(memory_id, revision),
  FOREIGN KEY (parent_id, parent_revision) REFERENCES memory_versions(memory_id, revision)
) STRICT;
CREATE INDEX memory_scope_status ON memory_entries(scope, status, updated_at);
CREATE VIRTUAL TABLE memory_search USING fts5(memory_id UNINDEXED, title_tokens, body_tokens);
`;

export const FRIEND_MIGRATIONS = [
  { version: 1, sql: INITIAL_SCHEMA },
  { version: 2, sql: MEMORY_SCHEMA },
] as const;
