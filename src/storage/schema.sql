CREATE TABLE IF NOT EXISTS users (
  user_id      INTEGER PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'allowed', 'denied')),
  first_name   TEXT,
  last_name    TEXT,
  username     TEXT,
  kindle_email TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per outstanding "request access" token; deleted on approve/reject.
CREATE TABLE IF NOT EXISTS access_requests (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (user, day); replaces limits.json's daily[day][userId] counters.
CREATE TABLE IF NOT EXISTS daily_usage (
  user_id INTEGER NOT NULL,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_daily_usage_day ON daily_usage(day);
CREATE INDEX IF NOT EXISTS idx_access_requests_user ON access_requests(user_id);
