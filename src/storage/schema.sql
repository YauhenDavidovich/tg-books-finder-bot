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

-- One row per search (text or photo): how it was served and how it ended.
-- Never the query text or the image. user_hash = sha256 of SEARCH_LOG_SALT
-- and the Telegram id (NULL while the salt isn't set).
CREATE TABLE IF NOT EXISTS search_log (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,               -- ISO 8601 UTC, when the search started
  kind       TEXT NOT NULL CHECK (kind IN ('text', 'photo')),
  cache_hit  INTEGER NOT NULL DEFAULT 0,
  via        TEXT CHECK (via IN ('freellmapi', 'direct')), -- 'direct' if any LLM step was; NULL = no LLM call
  model      TEXT,                        -- one per LLM step, joined with '+'
  latency_ms INTEGER,                     -- wall time of the LLM part, retries and fallbacks included
  ok         INTEGER NOT NULL,
  error_kind TEXT,                        -- see SEARCH_ERRORS in core/searchLog.js
  user_hash  TEXT,
  is_owner   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_search_log_ts ON search_log(ts);
