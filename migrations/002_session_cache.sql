-- Vilka sessioner som har replay-data cachad på disk (data/cache/sessions/<key>).
-- Själva datan ligger kvar som filer så att den dagliga DB-backupen hålls liten.
CREATE TABLE session_cache (
  session_key  INTEGER PRIMARY KEY,
  built_at     TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0
);
