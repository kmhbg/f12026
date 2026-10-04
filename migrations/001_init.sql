CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  password_hash TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE season_bets (
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_year          INTEGER NOT NULL,
  driver_predictions   TEXT NOT NULL DEFAULT '[]',
  team_predictions     TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (user_id, season_year)
);

CREATE TABLE race_bets (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_year       INTEGER NOT NULL,
  session_key       INTEGER NOT NULL,
  race_name         TEXT NOT NULL DEFAULT '',
  p1_driver_number  INTEGER,
  p2_driver_number  INTEGER,
  p3_driver_number  INTEGER,
  source            TEXT NOT NULL DEFAULT 'app',
  source_message_id TEXT,
  placed_at         TEXT,
  late_override     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, season_year, session_key)
);
CREATE INDEX race_bets_session ON race_bets(season_year, session_key);

-- Slutresultat (topp 3) för körda race. Ändras inte efter racet, så de
-- cachas här i stället för att hämtas från OpenF1 varje gång.
CREATE TABLE race_results (
  session_key INTEGER PRIMARY KEY,
  top3        TEXT NOT NULL,
  fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Avräkningar från före v2 (räknade med äldre regler) fryses här.
CREATE TABLE legacy_settlements (
  session_key INTEGER PRIMARY KEY,
  data        TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor_id TEXT,
  action   TEXT NOT NULL,
  details  TEXT
);
