-- What To Watch — D1 schema
-- Apply with: npx wrangler d1 execute whattowatch --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per title per list. owner_key is 'shared' or 'u<user id>'.
CREATE TABLE IF NOT EXISTS list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  owner_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('want', 'watching', 'watched')),
  title TEXT NOT NULL,
  poster TEXT,
  year TEXT,
  rating INTEGER,
  tmdb_rating REAL,
  added_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tmdb_id, media_type, owner_key)
);

-- Raw "now playing" reports pushed by the TV scrobbler app, resolved in the
-- site's inbox (assign to me / partner / both, matched to a TMDB title).
CREATE TABLE IF NOT EXISTS scrobbles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL,
  title TEXT,
  state TEXT NOT NULL,
  position_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_list_items_owner ON list_items (owner_key, status);
CREATE INDEX IF NOT EXISTS idx_scrobbles_status ON scrobbles (status, last_seen);
