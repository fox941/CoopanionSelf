/** Versioned schema for the companion's state, source events and recoverable local work. */
export const FRIEND_APPLICATION_ID = 0x46524e44;
export const FRIEND_SCHEMA_VERSION = 1;

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

export const FRIEND_MIGRATIONS = [{ version: 1, sql: INITIAL_SCHEMA }] as const;
