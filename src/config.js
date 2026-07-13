import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../data");

export const config = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  OWNER_ID: Number(process.env.OWNER_ID || 0),
  GOOGLE_BOOKS_API_KEY: process.env.GOOGLE_BOOKS_API_KEY || "",

  DATA_DIR,
  DB_FILE: process.env.DB_FILE || path.join(DATA_DIR, "bot.sqlite3"),
  // Legacy JSON store paths, kept only so a first boot against an existing
  // Railway volume can auto-migrate old data into SQLite (see storage/db.js).
  LEGACY_ACCESS_FILE: process.env.ACCESS_FILE || path.join(DATA_DIR, "access.json"),
  LEGACY_KINDLE_FILE: process.env.KINDLE_FILE || path.join(DATA_DIR, "kindle.json"),
  LEGACY_LIMITS_FILE: process.env.LIMITS_FILE || path.join(DATA_DIR, "limits.json"),

  DAILY_LIMIT: Number(process.env.DAILY_LIMIT || 15),
  // Was hardcoded to 0 (i.e. disabled) regardless of env in the previous version.
  ALLOWED_THREAD_ID: Number(process.env.ALLOWED_THREAD_ID || 0),

  MAX_TG_LEN: 3800,
  FLIBUSTA_BASE_URL: (process.env.FLIBUSTA_BASE_URL || "https://flibusta.is").replace(/\/+$/, ""),

  RAW_MODE: process.env.RAW_MODE === "1",
  FLIBUSTA_DEBUG: process.env.FLIBUSTA_DEBUG === "1",
  GEMINI_DEBUG: process.env.GEMINI_DEBUG === "1",
  DEBUG_ERRORS: process.env.DEBUG_ERRORS === "1",
};
