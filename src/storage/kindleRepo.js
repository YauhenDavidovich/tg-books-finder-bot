export function getKindleEmail(db, userId) {
  if (!userId) return "";
  const row = db.prepare("SELECT kindle_email FROM users WHERE user_id = ?").get(userId);
  return String(row?.kindle_email || "").trim();
}

export function setKindleEmail(db, userId, email) {
  db.prepare(
    `
    INSERT INTO users (user_id, status, kindle_email)
    VALUES (?, 'allowed', ?)
    ON CONFLICT(user_id) DO UPDATE SET kindle_email = excluded.kindle_email, updated_at = datetime('now')
  `
  ).run(userId, email);
}
