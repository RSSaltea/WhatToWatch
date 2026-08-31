-- Migration 004: per-user "not interested" exclusions for Discover.
CREATE TABLE IF NOT EXISTS not_interested (
  user_id INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  title TEXT,
  poster TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tmdb_id, media_type)
);
