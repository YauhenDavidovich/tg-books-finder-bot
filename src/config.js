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

  // LLM routing - see src/llm/client.js. Without LLM_BASE_URL/LLM_API_KEY
  // the default provider uses direct Gemini only.
  LLM_PROVIDER: process.env.LLM_PROVIDER || "freellmapi_with_fallback",
  LLM_BASE_URL: process.env.LLM_BASE_URL || "",
  LLM_API_KEY: process.env.LLM_API_KEY || "",
  LLM_MODEL: process.env.LLM_MODEL || "auto",
  LLM_VISION_MODEL: process.env.LLM_VISION_MODEL || "auto",
  // V2 enrich on the router (a short text call) - e.g. a profile without
  // Gemini models, so it doesn't spend Gemini's daily request quota.
  LLM_LIGHT_MODEL: process.env.LLM_LIGHT_MODEL || process.env.LLM_MODEL || "auto",
  // Separate budgets: vision on Gemini 3.5 Flash has taken up to ~16s.
  LLM_TIMEOUT_MS: Number(process.env.LLM_TIMEOUT_MS || 12000),
  LLM_VISION_TIMEOUT_MS: Number(process.env.LLM_VISION_TIMEOUT_MS || 25000),
  // json_schema lets the router enforce the shape natively on Gemini models
  // (and downgrade it per provider); json_object is the fallback knob if
  // json_schema turns out to trip up the free models in the chain.
  LLM_JSON_MODE: process.env.LLM_JSON_MODE || "json_schema",
  // Router-only: thinking effort for the cover steps (V1/V2). Empty = don't send.
  LLM_COVER_REASONING_EFFORT: process.env.LLM_COVER_REASONING_EFFORT ?? "minimal",
  LLM_DEBUG: process.env.LLM_DEBUG === "1",

  // Below this, a cover read is rejected ("Не уверен в названии").
  PHOTO_MIN_CONFIDENCE: Number(process.env.PHOTO_MIN_CONFIDENCE || 0.65),
  // Below this, text search warns about low confidence but still searches.
  TEXT_LOW_CONFIDENCE: Number(process.env.TEXT_LOW_CONFIDENCE || 0.25),

  RAW_MODE: process.env.RAW_MODE === "1",
  FLIBUSTA_DEBUG: process.env.FLIBUSTA_DEBUG === "1",
  GEMINI_DEBUG: process.env.GEMINI_DEBUG === "1",
  DEBUG_ERRORS: process.env.DEBUG_ERRORS === "1",
};
