# Refactor Plan — tg-books-finder-bot

Companion to `PRIORITIZED_FINDINGS.md`. Two parts: (1) module structure for the current flat `src/`, (2) a JSON → `better-sqlite3` migration sized as one evening of work. No code has been changed — this is the proposed plan for review.

---

## Part 1 — proposed module structure

Today everything funnels through one 1155-line `src/index.js` (see finding P2-1). Proposed split, keeping every existing file that's already well-scoped (`flibustaProvider.js`, `flibustaReply.js`, `books.js`, `geminiTextSearch.js`, `geminiVision.js`, `format.js`) untouched in place:

```
src/
  index.js                    # bootstrap only: load stores, register handlers, launch, shutdown
  config.js                   # env parsing (DATA_DIR, OWNER_ID, DAILY_LIMIT, FLIBUSTA_BASE_URL, ...)

  core/
    matching.js                # norm(), scoreMatch(), shortTitle()  — pure, exported, unit-testable
    cache.js                   # bounded LRU cache (replaces the raw `new Map()`)
    findFlow.js                 # handleFindQuery, tryFlibustaFirst, buildFlibustaAttemptsFromQuery

  access/
    accessControl.js            # isOwner, isAllowedUser, requestAccess, approve/reject, /users /allow /deny

  kindle/
    kindleEmail.js               # getKindleEmail/setKindleEmail/isValidKindleEmail
    kindleSender.js               # sendToKindle (Resend + SMTP), buildKindleButton, kindleSendStore

  storage/
    db.js                        # better-sqlite3 connection + migration runner (Part 2)
    accessRepo.js
    kindleRepo.js
    limitsRepo.js

  bot/
    commands.js                  # /find /users /allow /deny /smtp_test registration
    actions.js                   # bot.action(...) callback_query handlers
    textHandler.js                # bot.on("text")
    photoHandler.js               # bot.on("photo")

  providers/
    flibustaProvider.js           # unchanged
  googleBooks.js                  # renamed from books.js (name currently doesn't say "Google")
  geminiTextSearch.js              # unchanged, but reuse shared JSON-repair helpers (see below)
  geminiVision.js                  # unchanged
  format.js                       # unchanged (OCR text cleanup helpers)
  helpers/
    flibustaReply.js               # unchanged

  gemini/
    jsonExtract.js                 # shared stripCodeFences/extractJsonObject/tryRepairTruncatedJson
                                    # (currently duplicated-and-diverged between geminiVision.js and
                                    #  geminiTextSearch.js — fixes P1-3)
```

Deleted: `src/ocr.js` (orphaned, P1-6).

Each `bot/*Handler.js` file imports from `core/`, `access/`, `kindle/`, and `providers/` — no file does persistence + external API calls + Telegraf reply formatting all at once, which is the current god-file problem.

`index.js` shrinks to roughly:
```js
import "dotenv/config";
import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { openDb } from "./storage/db.js";
import { registerCommands } from "./bot/commands.js";
import { registerActions } from "./bot/actions.js";
import { registerTextHandler } from "./bot/textHandler.js";
import { registerPhotoHandler } from "./bot/photoHandler.js";

const bot = new Telegraf(config.BOT_TOKEN);
const db = openDb(config.DATA_DIR);

registerCommands(bot, db);
registerActions(bot, db);
registerTextHandler(bot, db);
registerPhotoHandler(bot, db);

bot.catch((err, ctx) => {
  console.error("bot error:", err);
  ctx.reply?.("Что-то пошло не так.").catch(() => {});
});

bot.launch().catch((e) => {
  console.error("launch failed:", e);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
```

This also directly fixes P0-3 and P1-5 from the findings doc as a side effect of the restructure.

---

## Part 2 — JSON files → `better-sqlite3`

### Why this removes a whole class of bug
`better-sqlite3` is synchronous and transactional. Replacing the current read-whole-file/mutate-in-memory/write-whole-file dance (P0-2) with real `INSERT`/`UPDATE` statements inside a WAL-mode database eliminates the "non-atomic write + silent reset-to-empty on corruption" risk entirely — SQLite's own durability guarantees replace the need for hand-rolled tmp+rename logic.

### Schema

```sql
-- storage/schema.sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;

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

-- one row per outstanding "request access" token (deleted on approve/reject)
CREATE TABLE IF NOT EXISTS access_requests (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- one row per (user, day); replaces limitsStore.daily[key][userId]
CREATE TABLE IF NOT EXISTS daily_usage (
  user_id INTEGER NOT NULL,
  day     TEXT NOT NULL,   -- 'YYYY-MM-DD', same format as current dayKey()
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_daily_usage_day ON daily_usage(day);
```

Notes:
- `users.status` folds `access.json`'s `allowed`/`pending` sets into one table (a pending row is `status='pending'`, still needs an `access_requests` row to carry the approve/reject token). `denied` is new — today a rejected user just has their pending entry deleted and leaves no trace; a `denied` status lets `/users` show history if wanted (optional, can be skipped if not needed).
- `kindle_email` folds into `users` directly rather than a separate table — 1:1 with a user, no reason to split (this replaces `kindle.json`).
- `daily_usage` replaces `limits.json`; `INSERT ... ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1` gives you the increment atomically in one statement, replacing the read-then-write pattern in `enforceDailyLimit`.

### Repo functions (same call sites, new implementation)

```js
// storage/accessRepo.js
export function isAllowedUser(db, userId) { ... }         // SELECT status FROM users WHERE user_id = ?
export function addAllowed(db, userId, meta) { ... }        // INSERT ... ON CONFLICT DO UPDATE SET status='allowed'
export function removeAllowed(db, userId) { ... }
export function addPendingRequest(db, token, userId, meta) { ... }
export function findPendingByUserId(db, userId) { ... }
export function resolvePendingRequest(db, token) { ... }    // returns the request row, deletes it
export function listAllowed(db) { ... }
export function listPending(db) { ... }

// storage/kindleRepo.js
export function getKindleEmail(db, userId) { ... }
export function setKindleEmail(db, userId, email) { ... }

// storage/limitsRepo.js
export function incrementAndCheck(db, userId, day, dailyLimit) { ... }  // one transaction: read+increment+check
```

All synchronous (no `await`), which also simplifies every call site currently doing `await saveXStore()`.

### Migration steps (target: one evening, ~4-6 hours)

1. **(30 min)** `npm install better-sqlite3`; remove `@google-cloud/vision`, `node-fetch` from `package.json` (P1-6/P1-7, unrelated to SQLite but cheap to bundle into the same evening); delete `src/ocr.js`.
2. **(45 min)** Add `storage/db.js` (opens `${DATA_DIR}/bot.sqlite3`, runs `schema.sql` via `db.exec(...)`, idempotent — safe to run on every boot) and `storage/schema.sql` above.
3. **(45 min)** Write a one-shot `scripts/migrate-json-to-sqlite.js`: reads `access.json`/`kindle.json`/`limits.json` if they exist, inserts corresponding rows, then renames the JSON files to `*.json.bak` (keep, don't delete — cheap rollback safety net). Run it once locally against a copy of the Railway volume before deploying.
4. **(60-90 min)** Write `storage/accessRepo.js`, `kindleRepo.js`, `limitsRepo.js` per the function list above.
5. **(60-90 min)** Update `index.js` call sites: replace `accessStore`/`kindleStore`/`limitsStore` + `loadXStore`/`saveXStore` with direct repo calls; delete the now-dead in-memory store objects and their load/save functions entirely (this is most of P2-1's persistence-boilerplate cleanup, achieved as a side effect).
6. **(30 min)** Smoke test locally: `/allow`, `/deny`, set Kindle email, run `/find`, restart the process, confirm access/Kindle/limit state survived the restart (this directly re-validates the concern P0-2 exists to prevent).
7. **(30 min)** Update README's persistent-storage section to describe `bot.sqlite3` on the Railway volume instead of `access.json`/`kindle.json`.

Total: ~4.5-6 hours, matching "one evening."

### Rollback plan
Keep the `*.json.bak` files from step 3 for at least one deploy cycle. If something's wrong with the SQLite path in production, reverting the commit and restoring `*.bak` → original filenames gets back to the current behavior with no data loss.

---

## Unit test plan for the scoring/matching module

Prerequisite: extract `norm`, `scoreMatch`, `shortTitle` out of `index.js` into `core/matching.js` and `export` them (P2-2) — they currently cannot be imported/tested at all.

Proposed `test/matching.test.js` using `node:test` + `node:assert`:

| # | Case | Input | Expected |
|---|------|-------|----------|
| 1 | Exact title match, no author | candidate `{title:"Война и мир"}`, query title `"Война и мир"`, no author | `score === 6` |
| 2 | Exact title + exact author | candidate `{title:"Идиот", author:"Достоевский"}`, query `"Идиот"`/`"Достоевский"` | `score === 10` (6+4) |
| 3 | Punctuation & case are ignored | candidate `"ВОЙНА, И МИР!!!"` vs query `"война и мир"` | treated as exact match (`norm` strips punctuation/case) |
| 4 | `ё`/`е` normalization | candidate `"Ёлка"` vs query `"елка"` | `norm()` output identical for both |
| 5 | Substring/partial match either direction | candidate `"Преступление и наказание"` vs query `"наказание"` | `score === 4` (partial branch, not exact) |
| 6 | Token overlap ≥ 0.8 boosts score without exact/substring match | candidate tokens `{середине, пути, перевал}` vs query `"перевал в середине пути"` reordered so it's not a substring | `+2` token-overlap bonus applied |
| 7 | Token overlap in the 0.6-0.8 band | query has 3 tokens, candidate title matches 2 of them | `+1` bonus (not `+2`) |
| 8 | No cross-script (Latin ↔ Cyrillic) matching | candidate `"Преступление и наказание"` vs query `"Crime and Punishment"` | `score === 0` — documents the current limitation (no transliteration bridging) |
| 9 | Author partial match | candidate author `"Фёдор Михайлович Достоевский"` vs query author `"достоевский"` | `+2` (substring branch, not the `+4` exact branch) |
| 10 | Missing/null fields don't throw | candidate `{title: undefined, author: null}`, query `{title:"x", author:"y"}` | `score === 0`, no exception |
| 11 | `shortTitle` cuts at delimiter but keeps original if the cut is too short | `"Война и мир: Том 1"` → `"Война и мир"`; but `": abc"` → falls back to the full original string (cut result `<4` chars) | matches both branches of the `cut.length >= 4 ? cut : s` guard |

These 11 cases cover: exact/partial/no-match scoring branches, the two token-overlap thresholds, Cyrillic normalization (`ё`→`е`), punctuation stripping, the documented Latin/Cyrillic gap, null-safety, and both branches of `shortTitle`. Once `core/matching.js` exists this is a same-evening addition (~1-2 hours) alongside the storage migration, though it's independent enough to land as its own smaller PR first.
