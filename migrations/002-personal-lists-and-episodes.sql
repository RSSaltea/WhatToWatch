-- Migration 002: shared list becomes derived (intersection of the two
-- personal lists), plus per-episode watch tracking and suggestion dismissals.

CREATE TABLE IF NOT EXISTS dismissed_suggestions (
  user_id INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  PRIMARY KEY (user_id, tmdb_id, media_type)
);

CREATE TABLE IF NOT EXISTS episode_watches (
  user_id INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  watched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tmdb_id, season, episode)
);

-- Move any old 'shared' rows onto the personal list of whoever added them.
INSERT OR IGNORE INTO list_items
  (tmdb_id, media_type, owner_key, status, title, poster, year, rating, tmdb_rating, added_by, updated_at)
SELECT tmdb_id, media_type, 'u' || added_by, status, title, poster, year, rating, tmdb_rating, added_by, updated_at
FROM list_items WHERE owner_key = 'shared';

DELETE FROM list_items WHERE owner_key = 'shared';
