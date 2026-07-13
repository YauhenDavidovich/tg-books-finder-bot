# Prioritized Findings — tg-books-finder-bot

Scope: full source review (`src/**`), `package.json`, `.gitignore`, README. All line numbers verified against current `main`.

---

## P0 — bugs, data loss, cost risk

### P0-1. Vision "enrichment" call is computed but never used — wasted Gemini spend + broken RU/EN cross-match
`src/geminiVision.js:225-276` makes a **second Gemini call** ("STEP 2: enrich") to produce `title_en`, `author_en`, `title_ru`, `author_ru`, and `variants` (6-10 EN/RU search variants), explicitly to help match RU catalog entries against EN book covers.

But the only caller, `src/index.js:1072-1076`:
```js
const guessedTitle = bestItem.title;
const guessedAuthor = bestItem.author || null;
const flibustaResult = await tryFlibustaFirst(ctx, { title: guessedTitle, author: guessedAuthor });
```
reads only the original (non-enriched) `title`/`author`. `title_ru`, `author_ru`, and `variants` are discarded. Every photo search pays for a Gemini call whose entire output is thrown away, and the one feature that would most help (matching an English cover to a Russian Flibusta listing) silently doesn't work.

**Fix:** either wire `variants`/`title_ru`/`author_ru` into a multi-attempt Flibusta search for photos (mirroring `buildFlibustaAttemptsFromQuery` used for text search), or delete the enrichment call if it's not worth the latency/cost.

### P0-2. Non-atomic JSON writes + silent reset-to-empty on corruption = risk of losing access/kindle/limits data
`src/index.js:72-121` (`saveAccessStore`, `saveKindleStore`, `saveLimitsStore`) all do a plain `fs.writeFile(path, json)` — no temp-file-plus-rename, no fsync, no lock. If the process is killed mid-write (Railway redeploy, OOM, crash) the file can be left truncated or invalid.

Worse, the load path treats **any** parse failure as "no data yet":
```js
// index.js:58-70
try {
  const raw = await fs.readFile(ACCESS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  ...
} catch {
  await saveAccessStore();   // <-- overwrites the corrupted file with an EMPTY store
}
```
A single corrupted write on `access.json` means every approved user silently loses access on next boot, and the corrupted file is immediately overwritten with an empty one — no backup, no alert, no distinction between "file doesn't exist yet" and "file is corrupt." Same pattern for `kindle.json` (loses saved Kindle emails) and `limits.json` (loses today's usage counts — actually harmless, but the pattern is the risk).

**Fix:** write to `${file}.tmp` then `fs.rename()` (atomic on POSIX); on parse failure, log loudly and keep a `.bak` copy instead of auto-overwriting; consider a single write queue per file to avoid interleaved writers (see P1-2 below for why this matters less than it looks, but the crash-safety gap is real regardless).

### P0-3. `bot.launch()` has no error handling — a bad token or network hiccup at boot can crash the process
`src/index.js:1153`:
```js
bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
```
`launch()` returns a promise; it's neither awaited nor given a `.catch()`. Node 15+ terminates the process by default on an unhandled promise rejection. If Telegram is briefly unreachable, DNS fails, or `BOT_TOKEN` is wrong at boot, this can crash the whole process — on Railway that becomes a crash-loop instead of a clean retry/backoff.

**Fix:** `bot.launch().catch((e) => { console.error("launch failed:", e); process.exit(1); });` at minimum; ideally retry with backoff before giving up.

### P0-4. Unbounded in-memory cache — slow memory leak on a long-running process
`src/index.js:32`: `const cache = new Map();` — used both for photo results (keyed by SHA-256 of the image) and text-search results (`find:${norm(...)}`, see `index.js:626` and `flibustaReply.js:99-101`). Entries are added forever and never evicted, expired, or size-capped. On a Railway long-poll deployment that stays up for weeks, every distinct photo and every distinct text query permanently grows this map — unbounded memory growth with no LRU/TTL/max-size guard.

**Fix:** cap size with a simple LRU (evict oldest on insert past N entries, e.g. 500) or add a TTL sweep; a tiny `Map`-based LRU is ~15 lines, no dependency needed.

### P0-5. `ALLOWED_THREAD_ID` is hardcoded to `0`, silently disabling a documented feature
`src/index.js:21`: `const ALLOWED_THREAD_ID = 0;` — this is a literal constant, not read from `process.env.ALLOWED_THREAD_ID` anywhere in the file. The README documents this as a configurable env var ("Можно ограничить обработку сообщений конкретным `ALLOWED_THREAD_ID`"), but `isAllowedTopic()` (`index.js:279-283`) always returns `true` because `!ALLOWED_THREAD_ID` is always true. The feature is completely dead code today, and anyone setting the env var in Railway gets no effect and no error.

**Fix:** `const ALLOWED_THREAD_ID = Number(process.env.ALLOWED_THREAD_ID || 0);`

---

## P1 — reliability

### P1-1. No timeouts on any outbound fetch except Kindle send
`geminiCallRaw` (`geminiTextSearch.js:35-89`), `geminiCallJsonImage` (`geminiVision.js:94-157`), `findBookByTitleAuthor`/`findBooksByQuery` (`books.js:19-61`), and `downloadTelegramFile` (`index.js:268-273`) all call `fetch()` with no `AbortController`/timeout. Only `sendToKindle` (`index.js:400-463`) wraps its call in a 20s `Promise.race` timeout — a good pattern that isn't applied anywhere else. A slow/hanging Gemini or Google Books response can hang a single user's request indefinitely (bounded only by whatever OS-level TCP timeout eventually fires).

**Fix:** wrap every external fetch in the same `Promise.race(..., timeout)` pattern already used for Kindle send (or a shared `fetchWithTimeout` helper), ~10-15s.

### P1-2. No retries anywhere
Every external call (Gemini text/vision, Flibusta via `flibusta-api`, Google Books, Telegram file download) is a single attempt. Transient network blips or Flibusta's documented 403/429 (already detected and translated into user messages in `flibustaProvider.js:36-64`) just fail the user's request outright instead of getting one retry with backoff.

**Fix:** one bounded retry (e.g. 1 retry after 500ms) for idempotent GETs (Flibusta search, Google Books, Gemini) — skip retrying on 4xx.

### P1-3. Text-search JSON parsing is deliberately fragile, inconsistent with the vision path
`geminiTextSearch.js:121-122` parses the model output with a bare `JSON.parse(r.candidateText)` and an explicit comment: *"тут принципиально: без strip/extract/repair"* (deliberately no fence-stripping/repair). Compare `geminiVision.js:127-148`, which strips ```` ```json ```` fences, extracts the `{...}` substring, and attempts to repair truncated JSON. If Gemini ever wraps the text-search response in a code fence or gets truncated (both of which the vision path defends against), the entire `/find` flow throws and the user sees a raw error message (caught generically at `index.js:975-979` / `1028-1032`). This is a real, currently-unguarded failure mode with no test coverage.

**Fix:** reuse the same `stripCodeFences`/`extractJsonObject`/`tryRepairTruncatedJson` helpers (move them to a shared module) for both call sites.

### P1-4. No per-minute/burst throttling — only a per-day cap
`enforceDailyLimit` (`index.js:129-150`) is well-implemented for its stated purpose — the read-check-increment happens synchronously with no `await` in between, so there's no race that lets concurrent messages exceed `DAILY_LIMIT` (verified: `getUserId`/`dayKey`/`isOwner` are all synchronous, so two interleaved calls can't both read the same stale `used` value). However there is **no per-minute or per-second cap**. A user (or a compromised/misbehaving client) can fire `DAILY_LIMIT` (default 15) requests in a few seconds, each triggering a Gemini call plus up to 4 sequential Flibusta search attempts (`buildFlibustaAttemptsFromQuery`, up to 4 queries per attempt × several attempts in `handleFindQuery`). This is a burst-amplification risk against Flibusta's own rate limiting, and burns through the daily allowance almost instantly with no cooldown. The owner (`isOwner`) bypasses `DAILY_LIMIT` entirely (`index.js:132`) with no limit of any kind — reasonable for a single-owner bot, but worth being deliberate about.

**Fix:** add a lightweight per-user sliding-window or token-bucket check (e.g. max 3 requests / 10s) before the daily-limit check.

### P1-5. No global `bot.catch()`; several handlers have no try/catch at all
`bot.command("find")`, `bot.on("text")`, and `bot.on("photo")` all wrap their bodies in try/catch and reply with an error message. But `bot.start` (`index.js:928-939`), `bot.hears("🔎 Find", ...)` (`index.js:941-948`), and `bot.hears(["📩 Kindle email", ...], ...)` (`index.js:950-957`) have **no try/catch**, and there is no `bot.catch(...)` registered anywhere on the `bot` instance. If `ctx.reply` throws in one of these (blocked-by-user, Telegram hiccup, etc.), Telegraf's default error handling just logs to console — the user gets zero feedback and the flow silently dies.

**Fix:** add `bot.catch((err, ctx) => { console.error(err); ctx.reply("Что-то пошло не так.").catch(() => {}); });` as a safety net, independent of per-handler try/catch.

### P1-6. `@google-cloud/vision` + `src/ocr.js` are fully orphaned
Confirmed via grep: `src/ocr.js` is not imported by any other file in the repo, and `@google-cloud/vision` is only used inside `ocr.js`. The README explicitly states vision extraction goes through Gemini, matching what `geminiVision.js` actually does. This is dead code plus a dead dependency that also implies an unused `GOOGLE_APPLICATION_CREDENTIALS`/`service-account.json` requirement (already special-cased in `.gitignore`) that nothing needs.

**Fix:** delete `src/ocr.js`, remove `@google-cloud/vision` from `package.json`.

### P1-7. `node-fetch` is unnecessary on the deployed runtime
Node 18.20.8 (confirmed locally, and Railway's default Node 18+ images) ships a native global `fetch`. `node-fetch` is imported in `index.js`, `books.js`, `geminiTextSearch.js`, and `geminiVision.js` purely as `import fetch from "node-fetch"` with no special options (no custom agent, no proxy) that would require the package.

**Fix:** drop the import in all four files (global `fetch` needs no import) and remove the dependency.

### P1-8. `.gitignore` doesn't cover the `data/` directory
`.gitignore` currently only lists `node_modules`, `.env`, `*.log`, `service-account.json`. `access.json` and `kindle.json` contain Telegram user IDs, names, usernames, and personal Kindle email addresses. If DATA_DIR/ACCESS_FILE/KINDLE_FILE env vars aren't set (e.g. someone runs locally per the README's own quick-start, which doesn't set `DATA_DIR`), these files are created under `./data` in the repo working tree and are **not excluded from git** — a `git add -A` or `git add .` would stage real user PII.

**Fix:** add `data/` to `.gitignore`.

### P1-9. `.DS_Store` is tracked in git
`git status` shows `M .DS_Store` at the repo root, meaning it was committed at some point. Not a security issue, but it's noise and a sign `.gitignore` hygiene hasn't been kept up.

**Fix:** `git rm --cached .DS_Store`, add `.DS_Store` to `.gitignore`.

---

## P2 — code quality / DX

### P2-1. `src/index.js` is a 1155-line god file
It currently owns: three near-identical copy-pasted JSON load/save implementations (access/kindle/limits — `index.js:58-121`), access-control logic, daily-limit logic, Kindle email validation, scoring/matching (`norm`, `scoreMatch` — `index.js:285-320`), string formatting helpers, Kindle email delivery via Resend **and** SMTP (`index.js:400-463`), Flibusta multi-attempt orchestration (`buildFlibustaAttemptsFromQuery`, `tryFlibustaFirst` — `index.js:466-573`), the core `handleFindQuery` flow, and all Telegraf command/action/message wiring. See `REFACTOR_PLAN.md` for a proposed split.

### P2-2. Scoring/matching logic isn't a module — can't be unit tested as-is
`norm`, `scoreMatch`, and `shortTitle` (`index.js:285-327`) are private functions inside `index.js`, not exported. There is currently no way to `node:test` them without extracting them first. See the test plan below and `REFACTOR_PLAN.md` for the extraction.

### P2-3. No automated tests exist
No `*.test.js` files anywhere in the repo, and no `test` script in `package.json`.

### P2-4. Single-best-match only — no infrastructure for top-N disambiguation
`tryFlibustaFirst` (`index.js:500-573`) always collapses candidates down to one `best` via a simple max-score loop and returns only that one book. There is no inline-keyboard flow letting the user pick among the top 3-5 candidates when the score is ambiguous or ties exist. The only place multiple candidates are ever shown is the owner-only `/fdebug` output (`formatFlibustaList`, `index.js:366-377`), which is not user-facing.

### P2-5. No `sendChatAction` during long operations
Neither the text-search flow nor the photo flow ever calls `ctx.sendChatAction("typing")` (or `"upload_document"`) before the Gemini/Flibusta round-trips, which can take several seconds combined. From the user's perspective the bot looks unresponsive during that window unless a debug mode happens to be on.

### P2-6. Tie-breaking in `tryFlibustaFirst` is order-dependent
```js
// index.js:549-558
let best = null, bestScore = -1;
for (const b of uniq) {
  const s = scoreMatch(b, tShort, qAuthor);
  if (s > bestScore) { bestScore = s; best = b; }   // strict >, first-seen wins ties
}
```
When two candidates tie on score, whichever appears first in `uniq` (itself dependent on Flibusta's own result ordering across multiple queries) wins, with no secondary criteria (e.g., prefer the one whose author also matched, or richer metadata).

### P2-7. `nodemailer` + `resend` overlap
Both are genuinely used — `sendToKindle` (`index.js:400-463`) picks Resend if `RESEND_API_KEY` is set, otherwise falls back to SMTP via `nodemailer` — so this isn't dead-code duplication, but it is real complexity (two email code paths, two sets of env vars, two error-message branches in the catch block at `index.js:770-784`) for what is presumably a single deployment's fixed choice. Worth a decision: pick one path for production and keep the other only if multi-provider support is an actual requirement.

---

## Security check (as requested)

- **Owner-approval bypass:** none found. `isOwner`/`isAllowedUser`/`isDebugAllowed` are consistently checked before privileged actions (`/allow`, `/deny`, `/users`, `acc:approve|reject`, `/smtp_test`, debug toggles). `OWNER_ID` defaults to `0`, and `isOwner` short-circuits on `Boolean(OWNER_ID)` so an unset owner can't accidentally match a falsy user id.
- **Daily-limit bypass:** none found (see P1-4 for the burst-throttling gap, which is a cost/reliability concern, not a bypass of the stated limit).
- **Secrets:** nothing sensitive is committed (`git ls-files` shows no `.env`, no `data/*.json`, no `service-account.json` tracked). See P1-8/P1-9 for `.gitignore` gaps that are currently latent, not yet triggered.
- **Callback-query token checks:** `kindle:send:<token>` validates both token existence and that the clicking user matches the token's stored `userId` (`index.js:732`) — good, prevents one user from redeeming another's Kindle-send button.
