// Ephemeral per-user UI-flow flags ("user just tapped Find / Kindle email
// button, next text message is the answer"). Fine to keep in-memory only -
// unlike access/kindle-email/limits, losing this on a restart just means the
// user taps the button again.
export const pendingFind = new Map();
export const pendingKindle = new Map();
