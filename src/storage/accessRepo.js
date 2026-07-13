export function isAllowedUser(db, userId) {
  const row = db.prepare("SELECT status FROM users WHERE user_id = ?").get(userId);
  return row?.status === "allowed";
}

export function addAllowed(db, userId, meta = {}) {
  db.prepare(
    `
    INSERT INTO users (user_id, status, first_name, last_name, username)
    VALUES (?, 'allowed', ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      status = 'allowed',
      first_name = COALESCE(excluded.first_name, users.first_name),
      last_name = COALESCE(excluded.last_name, users.last_name),
      username = COALESCE(excluded.username, users.username),
      updated_at = datetime('now')
  `
  ).run(userId, meta.firstName || null, meta.lastName || null, meta.username || null);
}

export function removeAllowed(db, userId) {
  db.prepare(
    `
    UPDATE users SET status = 'denied', updated_at = datetime('now')
    WHERE user_id = ? AND status = 'allowed'
  `
  ).run(userId);
}

export function listAllowed(db) {
  return db
    .prepare("SELECT user_id FROM users WHERE status = 'allowed' ORDER BY user_id")
    .all()
    .map((r) => r.user_id);
}

export function upsertPendingUser(db, userId, meta = {}) {
  db.prepare(
    `
    INSERT INTO users (user_id, status, first_name, last_name, username)
    VALUES (?, 'pending', ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      status = CASE WHEN users.status = 'allowed' THEN users.status ELSE 'pending' END,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      username = excluded.username,
      updated_at = datetime('now')
  `
  ).run(userId, meta.firstName || null, meta.lastName || null, meta.username || null);
}

export function addPendingRequest(db, token, userId) {
  db.prepare("INSERT INTO access_requests (token, user_id) VALUES (?, ?)").run(token, userId);
}

export function findPendingTokenByUserId(db, userId) {
  const row = db.prepare("SELECT token FROM access_requests WHERE user_id = ? LIMIT 1").get(userId);
  return row?.token || null;
}

export function getPendingRequest(db, token) {
  return db
    .prepare(
      `
    SELECT ar.token, ar.user_id AS userId, u.first_name AS firstName, u.last_name AS lastName, u.username
    FROM access_requests ar
    JOIN users u ON u.user_id = ar.user_id
    WHERE ar.token = ?
  `
    )
    .get(token);
}

export function deletePendingRequest(db, token) {
  db.prepare("DELETE FROM access_requests WHERE token = ?").run(token);
}

export function deletePendingRequestsByUserId(db, userId) {
  db.prepare("DELETE FROM access_requests WHERE user_id = ?").run(userId);
}

export function listPendingRequests(db) {
  return db
    .prepare(
      `
    SELECT ar.token, ar.user_id AS userId, u.username
    FROM access_requests ar
    JOIN users u ON u.user_id = ar.user_id
    ORDER BY ar.created_at
  `
    )
    .all();
}
