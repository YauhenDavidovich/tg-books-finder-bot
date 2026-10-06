import crypto from "crypto";
import { config } from "../config.js";
import { getUserId, isOwner } from "../access/accessControl.js";
import { insertSearchLog } from "../storage/searchLogRepo.js";

// search_log.error_kind values (ok = 0).
export const SEARCH_ERRORS = {
  LIMIT: "limit", // daily limit hit, nothing searched
  NO_DETAILS: "no_details", // text: the LLM found no query ("Мало деталей")
  LOW_CONFIDENCE: "low_confidence", // photo: no title or below PHOTO_MIN_CONFIDENCE
  NOT_FOUND: "not_found", // neither Flibusta nor Google Books had it
  LLM: "llm", // the LLM step threw (unusable JSON, router and Gemini both down)
  ERROR: "error", // anything else that threw
};

let warnedNoSalt = false;

export function hashUserId(userId, salt) {
  if (!userId || !salt) return null;
  return crypto.createHash("sha256").update(`${salt}:${userId}`).digest("hex");
}

// via/model for one search from its LLM steps (bookExtraction's `llm`
// array). A step that failed but was swallowed (enrich) still counts with
// its last attempt; via is "direct" if any step ended up on direct Gemini.
export function summarizeLlmSteps(steps = []) {
  const answered = steps.map((s) => (s?.via ? s : s?.attempts?.at(-1))).filter((s) => s?.via);
  if (!answered.length) return { via: null, model: null };
  return {
    via: answered.some((s) => s.via === "direct") ? "direct" : "freellmapi",
    model: answered.map((s) => s.model).join("+"),
  };
}

// Runs one search and writes its search_log row afterwards, whatever
// happened. `run` gets a recorder: `search.llm(promise)` wraps the LLM step,
// `search.cacheHit = true`, `search.fail(SEARCH_ERRORS.X)`. Errors are
// rethrown, so the handlers' own error replies stay as they were.
export async function withSearchLog({ ctx, db, kind, now = Date.now }, run) {
  const userId = getUserId(ctx);
  const search = {
    cacheHit: false,
    errorKind: null,
    llmSteps: [],
    latencyMs: null,
    fail(errorKind) {
      this.errorKind = errorKind;
    },
    async llm(promise) {
      const t0 = now();
      try {
        const result = await promise;
        this.llmSteps = result?.llm ?? [];
        return result;
      } catch (err) {
        this.errorKind = SEARCH_ERRORS.LLM;
        this.llmSteps = Array.isArray(err?.attempts) ? [{ attempts: err.attempts }] : [];
        throw err;
      } finally {
        this.latencyMs = now() - t0;
      }
    },
  };
  const ts = new Date(now()).toISOString();

  try {
    return await run(search);
  } catch (err) {
    search.errorKind ??= SEARCH_ERRORS.ERROR;
    throw err;
  } finally {
    writeRow(db, { ts, kind, userId, search });
  }
}

function writeRow(db, { ts, kind, userId, search }) {
  if (!config.SEARCH_LOG_SALT && !warnedNoSalt) {
    warnedNoSalt = true;
    console.warn("[search_log] SEARCH_LOG_SALT is not set - user_hash stays empty");
  }
  const { via, model } = summarizeLlmSteps(search.llmSteps);
  try {
    insertSearchLog(db, {
      ts,
      kind,
      cache_hit: search.cacheHit ? 1 : 0,
      via,
      model,
      latency_ms: search.latencyMs,
      ok: search.errorKind ? 0 : 1,
      error_kind: search.errorKind,
      user_hash: hashUserId(userId, config.SEARCH_LOG_SALT),
      is_owner: isOwner(userId) ? 1 : 0,
    });
  } catch (err) {
    // Stats must never break a search.
    console.warn(`[search_log] write failed: ${err?.message || err}`);
  }
}
