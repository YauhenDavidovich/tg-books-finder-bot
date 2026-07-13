// Synchronous, so the read-check-increment below can never interleave with
// another call the way a JSON read-modify-write-file cycle could.
export function incrementAndCheck(db, userId, day, dailyLimit) {
  if (!dailyLimit || dailyLimit <= 0) return { allowed: true, used: 0 };

  const row = db.prepare("SELECT count FROM daily_usage WHERE user_id = ? AND day = ?").get(userId, day);
  const used = Number(row?.count || 0);

  if (used >= dailyLimit) return { allowed: false, used };

  db.prepare(
    `
    INSERT INTO daily_usage (user_id, day, count) VALUES (?, ?, 1)
    ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1
  `
  ).run(userId, day);

  return { allowed: true, used: used + 1 };
}
