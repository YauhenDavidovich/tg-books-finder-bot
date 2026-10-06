// Runs the same text queries and fixture covers through FreeLLMAPI and
// through direct Gemini, then through the bot's Flibusta candidate search,
// and reports where switching providers changes what the user is offered.
//   node scripts/llm-compare.js [--texts-only | --covers-only] [--no-flibusta]
// The router side runs without fallback (LLM_PROVIDER=freellmapi semantics),
// so router failures show up as failures instead of quietly becoming Gemini.
// Optional fixtures/expected.json ({ "<file name>": ["acceptable title", ...] })
// adds a correctness check for covers; text queries carry their own.
// Needs Node 20+ (flibusta-api).
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { createLlm } from "../src/llm/client.js";
import { geminiText, geminiVision } from "../src/llm/gemini-direct.js";
import { extractBookQueryFromText, extractBookFromImage } from "../src/llm/bookExtraction.js";
import { buildFlibustaAttemptsFromQuery, buildFlibustaAttemptsFromVisionItem } from "../src/core/flibustaAttempts.js";
import { pickFlibustaCandidates } from "../src/core/findFlow.js";
import { norm } from "../src/core/matching.js";
import { FIXTURES_DIR, listCoverFixtures, loadAsTelegramPhoto } from "./lib/fixtures.js";

const TEXT_QUERIES = [
  { text: "антиутопия про стеклянный город и нумера, автор вроде Замятин", expect: ["Мы"] },
  { text: "роман, где дьявол со свитой приезжает в Москву, а с ним говорящий кот", expect: ["Мастер и Маргарита"] },
  { text: "book about a boy wizard with a scar who goes to a magic school", expect: ["Гарри Поттер"] },
  { text: "Стивен Кинг, клоун в канализации и дети из маленького городка", expect: ["Оно"] },
  { text: "фантастика про пустынную планету, пряность и гигантских песчаных червей", expect: ["Дюна"] },
];

function loadCoverExpectations() {
  try {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "expected.json"), "utf8"));
  } catch {
    return {};
  }
}

const args = new Set(process.argv.slice(2));
const withFlibusta = !args.has("--no-flibusta");

const warnings = [];
const logger = { warn: (m) => warnings.push(m), log() {} };
const gemini = { text: geminiText, vision: geminiVision };

const sides = {
  router: createLlm({
    provider: "freellmapi",
    baseURL: config.LLM_BASE_URL,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
    visionModel: config.LLM_VISION_MODEL,
    timeoutMs: config.LLM_TIMEOUT_MS,
    jsonMode: config.LLM_JSON_MODE,
    logger,
  }),
  direct: createLlm({ provider: "direct", logger }),
};
for (const llm of Object.values(sides)) llm.setDirectFallback(gemini);

const coverExpectations = loadCoverExpectations();
const inputs = [
  ...(args.has("--covers-only") ? [] : TEXT_QUERIES.map(({ text, expect }) => ({ kind: "text", label: text, expect }))),
  ...(args.has("--texts-only")
    ? []
    : listCoverFixtures().map((file) => ({
        kind: "cover",
        label: path.basename(file),
        file,
        expect: coverExpectations[path.basename(file)],
      }))),
];

const firstLine = (err) => String(err?.message || err).split("\n")[0].slice(0, 300);
const stepModels = (steps) =>
  (steps || []).map((s) => `${s.step}: ${s.error ? `✗ ${s.error.slice(0, 80)}` : `${s.model} ${s.latencyMs}ms`}`).join(", ");

async function extract(llm, input) {
  const t0 = Date.now();
  try {
    if (input.kind === "text") {
      const { query: q, llm: steps } = await extractBookQueryFromText(input.label, { llm });
      const rejected = q.query ? null : "мало деталей (empty query)";
      return {
        ms: Date.now() - t0,
        steps,
        read: { title: q.title, author: q.author, title_ru: q.title_ru, author_ru: q.author_ru, query: q.query, confidence: q.confidence },
        rejected,
        attempts: rejected ? [] : buildFlibustaAttemptsFromQuery(q, input.label),
      };
    }

    const { items, llm: steps } = await extractBookFromImage(input.image, "image/jpeg", { llm });
    const best = items[0];
    // Same gate as photoHandler.js.
    const rejected = !best?.title
      ? "не уверен (no title)"
      : best.confidence < config.PHOTO_MIN_CONFIDENCE
        ? `не уверен (confidence ${best.confidence} < ${config.PHOTO_MIN_CONFIDENCE})`
        : null;
    return {
      ms: Date.now() - t0,
      steps,
      read: best
        ? { title: best.title, author: best.author, title_ru: best.title_ru, author_ru: best.author_ru, confidence: best.confidence, evidence: best.evidence }
        : null,
      rejected,
      attempts: rejected ? [] : buildFlibustaAttemptsFromVisionItem(best),
    };
  } catch (err) {
    return { ms: Date.now() - t0, error: firstLine(err), steps: err?.attempts ? [{ step: "failed", attempts: err.attempts }] : [] };
  }
}

// Identical attempts give identical Flibusta results - don't query twice.
const flibustaCache = new Map();
function flibustaTop(attempts) {
  if (!withFlibusta || !attempts?.length) return Promise.resolve({ books: [] });
  const key = JSON.stringify(attempts);
  if (!flibustaCache.has(key)) {
    flibustaCache.set(
      key,
      pickFlibustaCandidates({}, attempts, 3).then(
        (ranked) => ({ books: ranked.map((c) => ({ id: c.book.id, title: c.book.title, author: c.book.author, score: c.score })) }),
        (err) => ({ error: `${firstLine(err)}${err?.cause ? ` (${firstLine(err.cause)})` : ""}`, books: [] })
      )
    );
  }
  return flibustaCache.get(key);
}

const fmtRead = (r) =>
  !r ? "-" : `${r.title ?? "∅"} — ${r.author ?? "∅"} (${Number(r.confidence ?? 0).toFixed(2)})${r.title_ru && r.title_ru !== r.title ? ` ru: ${r.title_ru}` : ""}`;
const fmtBook = (b) => (b ? `${b.title}${b.author ? ` — ${b.author}` : ""} [${b.id}]` : "-");
const sameText = (a, b) => norm(a ?? "") === norm(b ?? "");

// Exact match for short titles ("Мы", "Оно"), containment for longer ones
// (catalog titles carry subtitles: "Илон Маск. Tesla, SpaceX и дорога в будущее").
function matchesExpected(title, expect) {
  const t = norm(title ?? "");
  if (!t || !expect?.length) return false;
  return expect.some((e) => {
    const x = norm(e);
    return t === x || (x.length >= 6 && t.includes(x));
  });
}

// ✓ = expected book is Flibusta's #1, ~ = it's in the top 3, ✗ = not offered.
function correctness(side, expect) {
  if (!expect?.length) return "?";
  if (side.error || side.rejected) return "✗";
  const books = side.flibusta.books;
  if (matchesExpected(books[0]?.title, expect)) return "✓";
  return books.some((b) => matchesExpected(b.title, expect)) ? "~" : "✗";
}

const results = [];

for (const [i, input] of inputs.entries()) {
  if (input.kind === "cover") input.image = loadAsTelegramPhoto(input.file);
  console.log(`\n[${i + 1}/${inputs.length}] ${input.kind}: ${input.label}`);

  const row = { kind: input.kind, input: input.label };
  for (const side of ["router", "direct"]) {
    warnings.length = 0;
    const r = await extract(sides[side], input);
    r.flibusta = r.error ? { books: [] } : await flibustaTop(r.attempts);
    r.warnings = [...warnings];
    row[side] = r;

    console.log(`  ${side.padEnd(6)} ${(r.ms / 1000).toFixed(1)}s  ${stepModels(r.steps)}`);
    if (r.error) console.log(`         ✗ ${r.error}`);
    else console.log(`         read: ${fmtRead(r.read)}${r.rejected ? `  -> ${r.rejected}` : ""}`);
    for (const w of r.warnings) console.log(`         ! ${w.slice(0, 200)}`);
    if (r.flibusta.error) console.log(`         flibusta ✗ ${r.flibusta.error}`);
    else if (!r.rejected && !r.error) console.log(`         flibusta: ${r.flibusta.books.map((b, n) => `${n + 1}) ${fmtBook(b)}`).join("  ") || "nothing"}`);
  }

  const [a, b] = [row.router, row.direct];
  const sameRead = !a.error && !b.error && sameText(a.read?.title, b.read?.title) && sameText(a.read?.author, b.read?.author);
  const sameGate = Boolean(a.rejected) === Boolean(b.rejected);
  const sameTop1 = String(a.flibusta.books[0]?.id ?? "") === String(b.flibusta.books[0]?.id ?? "");
  row.verdict =
    a.error || b.error
      ? `error on ${[a.error && "router", b.error && "direct"].filter(Boolean).join(" + ")}`
      : !sameGate
        ? `gate differs: router ${a.rejected ? "rejects" : "accepts"}, direct ${b.rejected ? "rejects" : "accepts"}`
        : sameTop1
          ? sameRead
            ? "same"
            : "same book, different read"
          : "different top-1";
  row.correct = { router: correctness(a, input.expect), direct: correctness(b, input.expect) };
  console.log(`  => ${row.verdict}; expected book: router ${row.correct.router}, direct ${row.correct.direct}`);
  results.push(row);
}

const cell = (s) => String(s ?? "-").replace(/\|/g, "/").replace(/\n/g, " ");
console.log("\n| # | input | router models | router read | direct read | Flibusta #1 router | Flibusta #1 direct | router ok | direct ok | verdict |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
results.forEach((r, i) => {
  const read = (s) => (s.error ? `✗ ${s.error.slice(0, 60)}` : `${fmtRead(s.read)}${s.rejected ? ` → ${s.rejected}` : ""}`);
  const top = (s) => (s.rejected || s.error ? "-" : s.flibusta.error ? `✗ ${s.flibusta.error.slice(0, 50)}` : fmtBook(s.flibusta.books[0]));
  console.log(
    `| ${i + 1} | ${cell(r.input.slice(0, 50))} | ${cell(stepModels(r.router.steps))} | ${cell(read(r.router))} | ${cell(read(r.direct))} | ${cell(top(r.router))} | ${cell(top(r.direct))} | ${r.correct.router} | ${r.correct.direct} | ${cell(r.verdict)} |`
  );
});

const totals = (side) => results.reduce((sum, r) => sum + r[side].ms, 0) / 1000;
const score = (side) => {
  const marks = results.map((r) => r.correct[side]).filter((m) => m !== "?");
  return `${marks.filter((m) => m === "✓").length}/${marks.length} at #1, ${marks.filter((m) => m !== "✗").length}/${marks.length} in top 3`;
};
console.log(`\nexpected book offered: router ${score("router")}; direct ${score("direct")}`);
console.log(`LLM time total: router ${totals("router").toFixed(1)}s, direct ${totals("direct").toFixed(1)}s`);

const out = path.join(os.tmpdir(), `tg-books-finder-compare-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`full results: ${out}`);
