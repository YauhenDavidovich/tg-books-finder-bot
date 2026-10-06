import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";

// config.js reads env at import time: set the salt and owner before any
// module that imports it (hence dynamic imports only below).
process.env.SEARCH_LOG_SALT = "test-salt";
process.env.OWNER_ID = "42";
const { LlmJsonError } = await import("../src/llm/client.js");
const { withSearchLog, hashUserId, summarizeLlmSteps, SEARCH_ERRORS } = await import("../src/core/searchLog.js");
const { summarizeSearchLog } = await import("../src/core/usageReport.js");

function freshDb() {
  const db = new Database(":memory:");
  db.exec(fs.readFileSync(new URL("../src/storage/schema.sql", import.meta.url), "utf8"));
  return db;
}

const ctxFor = (id) => ({ from: { id } });
const rows = (db) => db.prepare("SELECT * FROM search_log ORDER BY id").all();
const clock = (...ticks) => () => ticks.shift() ?? 0;

const coverSteps = [
  { step: "cover", via: "freellmapi", model: "google/gemini-3.5-flash", latencyMs: 9000 },
  { step: "enrich", via: "direct", model: "gemini-2.5-flash", latencyMs: 1200 },
];

test("hashUserId: salted sha256, null without a salt or id", () => {
  assert.equal(hashUserId(7, ""), null);
  assert.equal(hashUserId(0, "s"), null);
  assert.match(hashUserId(7, "s"), /^[0-9a-f]{64}$/);
  assert.equal(hashUserId(7, "s"), hashUserId(7, "s"));
  assert.notEqual(hashUserId(7, "s"), hashUserId(7, "t"));
});

test("summarizeLlmSteps: direct if any step was, models joined, swallowed step uses its last attempt", () => {
  assert.deepEqual(summarizeLlmSteps(coverSteps), { via: "direct", model: "google/gemini-3.5-flash+gemini-2.5-flash" });
  assert.deepEqual(summarizeLlmSteps(coverSteps.slice(0, 1)), { via: "freellmapi", model: "google/gemini-3.5-flash" });
  assert.deepEqual(
    summarizeLlmSteps([coverSteps[0], { step: "enrich", error: "x", attempts: [{ via: "freellmapi", model: "groq/llama" }] }]),
    { via: "freellmapi", model: "google/gemini-3.5-flash+groq/llama" }
  );
  assert.deepEqual(summarizeLlmSteps([]), { via: null, model: null });
});

test("withSearchLog: a found photo is one ok row with via/model/LLM wall time, no query or image stored", async () => {
  const db = freshDb();
  await withSearchLog({ ctx: ctxFor(7), db, kind: "photo", now: clock(1_000, 1_100, 11_600) }, async (search) => {
    await search.llm(Promise.resolve({ items: [], llm: coverSteps }));
  });

  const [row] = rows(db);
  assert.deepEqual(
    { ...row, id: undefined },
    {
      id: undefined,
      ts: new Date(1_000).toISOString(),
      kind: "photo",
      cache_hit: 0,
      via: "direct",
      model: "google/gemini-3.5-flash+gemini-2.5-flash",
      latency_ms: 10_500,
      ok: 1,
      error_kind: null,
      user_hash: hashUserId(7, "test-salt"),
      is_owner: 0,
    }
  );
});

test("withSearchLog: limit, cache hit, owner and not-found outcomes", async () => {
  const db = freshDb();
  await withSearchLog({ ctx: ctxFor(7), db, kind: "text" }, async (search) => search.fail(SEARCH_ERRORS.LIMIT));
  await withSearchLog({ ctx: ctxFor(42), db, kind: "photo" }, async (search) => {
    search.cacheHit = true;
  });
  await withSearchLog({ ctx: ctxFor(7), db, kind: "text" }, async (search) => {
    await search.llm(Promise.resolve({ llm: [{ via: "freellmapi", model: "m" }] }));
    search.fail(SEARCH_ERRORS.NOT_FOUND);
  });

  assert.deepEqual(
    rows(db).map((r) => [r.kind, r.ok, r.error_kind, r.cache_hit, r.is_owner, r.via]),
    [
      ["text", 0, "limit", 0, 0, null],
      ["photo", 1, null, 1, 1, null],
      ["text", 0, "not_found", 0, 0, "freellmapi"],
    ]
  );
});

test("withSearchLog: LLM error -> error_kind llm with the last attempt's via; other errors -> error; both rethrown", async () => {
  const db = freshDb();
  const llmErr = new LlmJsonError("unusable", {
    attempts: [
      { via: "freellmapi", model: "nemotron" },
      { via: "direct", model: "gemini-2.5-flash" },
    ],
  });

  await assert.rejects(
    withSearchLog({ ctx: ctxFor(7), db, kind: "text" }, (search) => search.llm(Promise.reject(llmErr))),
    llmErr
  );
  await assert.rejects(
    withSearchLog({ ctx: ctxFor(7), db, kind: "photo" }, async () => {
      throw new Error("telegram download failed");
    }),
    /telegram download failed/
  );

  assert.deepEqual(
    rows(db).map((r) => [r.kind, r.ok, r.error_kind, r.via, r.model]),
    [
      ["text", 0, "llm", "direct", "gemini-2.5-flash"],
      ["photo", 0, "error", null, null],
    ]
  );
});

test("withSearchLog: a failed write never breaks the search", async () => {
  const db = new Database(":memory:"); // no search_log table
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await withSearchLog({ ctx: ctxFor(7), db, kind: "text" }, async () => "result"), "result");
  } finally {
    console.warn = warn;
  }
});

test("summarizeSearchLog: zero-filled days, limit kept apart, fallback %, models, latency", () => {
  const r = (ts, extra) => ({ ts, kind: "text", cache_hit: 0, via: null, model: null, latency_ms: null, ok: 1, error_kind: null, user_hash: "u1", is_owner: 0, ...extra });
  const s = summarizeSearchLog(
    [
      r("2026-10-04T10:00:00.000Z", { via: "freellmapi", model: "a", latency_ms: 100 }),
      r("2026-10-04T11:00:00.000Z", { kind: "photo", via: "direct", model: "a+b", latency_ms: 300, is_owner: 1, user_hash: "o" }),
      r("2026-10-06T09:00:00.000Z", { via: "freellmapi", model: "a", latency_ms: 200, user_hash: "u2", ok: 0, error_kind: "not_found" }),
      r("2026-10-06T09:30:00.000Z", { ok: 0, error_kind: "limit" }),
      r("2026-09-01T00:00:00.000Z", { via: "direct", model: "old" }), // outside the window
    ],
    { days: 3, today: "2026-10-06" }
  );

  assert.deepEqual([s.from, s.to], ["2026-10-04", "2026-10-06"]);
  assert.deepEqual(s.daily.map((d) => [d.day, d.searches, d.limit]), [
    ["2026-10-04", 2, 0],
    ["2026-10-05", 0, 0],
    ["2026-10-06", 1, 1],
  ]);
  assert.deepEqual([s.searches, s.text, s.photo, s.owner, s.others, s.otherUsers, s.limit], [3, 2, 1, 1, 2, 2, 1]);
  assert.deepEqual(s.perDay, { max: 2, mean: 1, median: 1 });
  assert.deepEqual(s.via, { freellmapi: 2, direct: 1 });
  assert.equal(s.fallbackPct.toFixed(1), "33.3");
  assert.deepEqual(s.models, [["a", 3], ["b", 1]]);
  assert.deepEqual(s.latency, [
    { kind: "text", via: "freellmapi", n: 2, median: 150, p90: 200 },
    { kind: "photo", via: "direct", n: 1, median: 300, p90: 300 },
  ]);
  assert.deepEqual(s.outcomes, [["ok", 2], ["not_found", 1]]);
});
