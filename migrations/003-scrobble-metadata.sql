-- Migration 003: richer scrobble metadata from the TV app.
ALTER TABLE scrobbles ADD COLUMN subtitle TEXT;
ALTER TABLE scrobbles ADD COLUMN description TEXT;
ALTER TABLE scrobbles ADD COLUMN duration_ms INTEGER;
