import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

function readJsonIfExists(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function backupLegacyFile(filePath) {
  try {
    fs.renameSync(filePath, `${filePath}.bak`);
  } catch (e) {
    console.error(`Could not rename legacy file ${filePath} after migration:`, e?.message || e);
  }
}

// One-time import of the old JSON stores into SQLite. Only runs the first
// time bot.sqlite3 is created, so existing approved users / Kindle emails /
// daily counters survive the switch from JSON files without any manual step.
function migrateLegacyJsonIntoDb(db, { legacyAccessFile, legacyKindleFile, legacyLimitsFile }) {
  const upsertUser = db.prepare(`
    INSERT INTO users (user_id, status, first_name, last_name, username, created_at)
    VALUES (@user_id, @status, @first_name, @last_name, @username, @created_at)
    ON CONFLICT(user_id) DO UPDATE SET
      status = excluded.status,
      first_name = COALESCE(excluded.first_name, users.first_name),
      last_name = COALESCE(excluded.last_name, users.last_name),
      username = COALESCE(excluded.username, users.username)
  `);
  const insertRequest = db.prepare(`
    INSERT OR REPLACE INTO access_requests (token, user_id, created_at)
    VALUES (?, ?, ?)
  `);

  const access = readJsonIfExists(legacyAccessFile);
  if (access) {
    const migrate = db.transaction(() => {
      const allowed = Array.isArray(access.allowed) ? access.allowed : [];
      for (const rawId of allowed) {
        const userId = Number(rawId);
        if (!userId) continue;
        upsertUser.run({
          user_id: userId,
          status: "allowed",
          first_name: null,
          last_name: null,
          username: null,
          created_at: new Date().toISOString(),
        });
      }

      const pending = access.pending && typeof access.pending === "object" ? access.pending : {};
      for (const [token, req] of Object.entries(pending)) {
        const userId = Number(req?.userId);
        if (!userId) continue;
        upsertUser.run({
          user_id: userId,
          status: "pending",
          first_name: req?.firstName || null,
          last_name: req?.lastName || null,
          username: req?.username || null,
          created_at: req?.createdAt || new Date().toISOString(),
        });
        insertRequest.run(token, userId, req?.createdAt || new Date().toISOString());
      }
    });
    migrate();
    console.log(`Migrated legacy access store (${legacyAccessFile}) into SQLite.`);
    backupLegacyFile(legacyAccessFile);
  }

  const setKindleEmail = db.prepare(`
    INSERT INTO users (user_id, status, kindle_email)
    VALUES (?, 'allowed', ?)
    ON CONFLICT(user_id) DO UPDATE SET kindle_email = excluded.kindle_email
  `);

  const kindle = readJsonIfExists(legacyKindleFile);
  if (kindle) {
    const emails = kindle.emails && typeof kindle.emails === "object" ? kindle.emails : {};
    const migrate = db.transaction(() => {
      for (const [rawId, email] of Object.entries(emails)) {
        const userId = Number(rawId);
        if (!userId || !email) continue;
        setKindleEmail.run(userId, String(email));
      }
    });
    migrate();
    console.log(`Migrated legacy kindle store (${legacyKindleFile}) into SQLite.`);
    backupLegacyFile(legacyKindleFile);
  }

  const setUsage = db.prepare(`
    INSERT OR REPLACE INTO daily_usage (user_id, day, count) VALUES (?, ?, ?)
  `);

  const limits = readJsonIfExists(legacyLimitsFile);
  if (limits) {
    const daily = limits.daily && typeof limits.daily === "object" ? limits.daily : {};
    const migrate = db.transaction(() => {
      for (const [day, bucket] of Object.entries(daily)) {
        if (!bucket || typeof bucket !== "object") continue;
        for (const [rawId, count] of Object.entries(bucket)) {
          const userId = Number(rawId);
          const n = Number(count);
          if (!userId || !Number.isFinite(n)) continue;
          setUsage.run(userId, day, n);
        }
      }
    });
    migrate();
    console.log(`Migrated legacy limits store (${legacyLimitsFile}) into SQLite.`);
    backupLegacyFile(legacyLimitsFile);
  }
}

export function openDb(config) {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });

  const isNewDb = !fs.existsSync(config.DB_FILE);
  const db = new Database(config.DB_FILE);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));

  if (isNewDb) {
    migrateLegacyJsonIntoDb(db, {
      legacyAccessFile: config.LEGACY_ACCESS_FILE,
      legacyKindleFile: config.LEGACY_KINDLE_FILE,
      legacyLimitsFile: config.LEGACY_LIMITS_FILE,
    });
  }

  return db;
}
