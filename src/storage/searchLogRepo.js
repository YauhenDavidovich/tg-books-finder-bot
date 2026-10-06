export function insertSearchLog(db, row) {
  db.prepare(
    `
    INSERT INTO search_log (ts, kind, cache_hit, via, model, latency_ms, ok, error_kind, user_hash, is_owner)
    VALUES (@ts, @kind, @cache_hit, @via, @model, @latency_ms, @ok, @error_kind, @user_hash, @is_owner)
  `
  ).run(row);
}

export function listSearchLogSince(db, sinceTs) {
  return db.prepare("SELECT * FROM search_log WHERE ts >= ? ORDER BY ts").all(sinceTs);
}
