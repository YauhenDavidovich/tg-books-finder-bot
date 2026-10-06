import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createLlm } from "../src/llm/client.js";
import { geminiText, geminiVision } from "../src/llm/gemini-direct.js";
import {
  extractBookQueryFromText,
  extractBookFromImage,
  BookQuerySchema,
  CoverExtractSchema,
  EnrichSchema,
} from "../src/llm/bookExtraction.js";
import { toJsonSchema, describeShape } from "../src/llm/geminiSchema.js";
import { startRouter, completion, failure, silentLogger } from "./helpers/fakeRouter.js";

// Requests and results of the pre-router geminiTextSearch.js/geminiVision.js
// for fixed Gemini answers - the direct path must reproduce them exactly.
const ref = JSON.parse(fs.readFileSync(new URL("./fixtures/gemini-reference.json", import.meta.url)));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function directLlm(geminiAnswers) {
  process.env.GEMINI_API_KEY = "test-key";
  const requests = [];
  const queue = [...geminiAnswers];
  globalThis.fetch = async (url, init) => {
    requests.push(JSON.parse(init.body));
    const answer = queue.shift();
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: "STOP" }] }), {
      status: 200,
    });
  };
  const llm = createLlm({ provider: "direct", logger: silentLogger });
  llm.setDirectFallback({ text: geminiText, vision: geminiVision });
  return { llm, requests };
}

function routerLlm(router, directAnswer = "{}") {
  const calls = [];
  const llm = createLlm({ baseURL: router.baseURL, apiKey: "k", visionModel: "auto:vision", logger: silentLogger });
  llm.setDirectFallback({
    text: async (prompt, opts) => {
      calls.push({ kind: "text", prompt, opts });
      return directAnswer;
    },
    vision: async (b64, mimeType, prompt, opts) => {
      calls.push({ kind: "vision", b64, prompt, opts });
      return directAnswer;
    },
  });
  return { llm, direct: { calls } };
}

const imageBuffer = () => Buffer.from(ref.cover.imageBase64, "base64");

// ---------- direct Gemini path == pre-router behavior ----------

test("T1 direct: same Gemini request and parsed query as before", async () => {
  const { llm, requests } = directLlm([ref.text.response]);
  const { query, llm: steps } = await extractBookQueryFromText(ref.text.input, { llm });

  assert.deepEqual(requests, [ref.text.request]);
  assert.deepEqual(query, ref.text.parsed);
  assert.equal(steps[0].via, "direct");
  assert.equal(steps[0].model, "gemini-2.5-flash");
});

test("V1+V2 direct: same two vision requests (V2 with the image) and same item as before", async () => {
  const { llm, requests } = directLlm(ref.cover.responses);
  const result = await extractBookFromImage(imageBuffer(), ref.cover.mimeType, { llm });

  assert.deepEqual(requests, ref.cover.requests);
  assert.deepEqual(result.items, ref.cover.result.items);
  assert.deepEqual(
    result.llm.map((s) => [s.step, s.via]),
    [
      ["cover", "direct"],
      ["enrich", "direct"],
    ]
  );
});

test("V1 direct with no items: one request, empty result as before", async () => {
  const { llm, requests } = directLlm([ref.coverEmpty.response]);
  const result = await extractBookFromImage(imageBuffer(), ref.cover.mimeType, { llm });

  assert.deepEqual(requests, ref.coverEmpty.requests);
  assert.deepEqual(result.items, ref.coverEmpty.result.items);
});

// ---------- router path ----------

test("T1 router: system prompt with shape and rules, json_schema, no reasoning_effort", async (t) => {
  const router = await startRouter(() => completion(JSON.stringify(ref.text.response)));
  t.after(router.close);
  const { llm } = routerLlm(router);

  const { query } = await extractBookQueryFromText(ref.text.input, { llm });
  assert.deepEqual(query, ref.text.parsed);

  const body = router.requests[0];
  assert.equal(body.model, "auto");
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.response_format.json_schema.name, "book_query");
  assert.deepEqual(body.response_format.json_schema.schema.properties.title, { type: ["string", "null"] });
  const system = body.messages[0].content;
  assert.match(system, /"query": string, "title": string\|null/);
  assert.match(system, /do not translate/);
  assert.match(system, /Never invent/);
  assert.equal(body.messages[1].content, ref.text.request.contents[0].parts[0].text, "user prompt unchanged");
});

test("V1 router is vision with minimal reasoning; V2 router is text-only, image goes to Gemini only", async (t) => {
  const router = await startRouter((body, n) => completion(JSON.stringify(ref.cover.responses[n - 1])));
  t.after(router.close);
  const { llm } = routerLlm(router);

  const result = await extractBookFromImage(imageBuffer(), ref.cover.mimeType, { llm });
  assert.deepEqual(result.items, ref.cover.result.items);

  const [v1, v2] = router.requests;
  assert.equal(v1.model, "auto:vision");
  assert.equal(v1.reasoning_effort, "minimal");
  assert.equal(v1.messages.at(-1).content[1].type, "image_url");
  assert.match(v1.messages[0].content, /only a name you can actually read on the image/);

  assert.equal(v2.model, "auto");
  assert.equal(v2.reasoning_effort, "minimal");
  assert.equal(typeof v2.messages.at(-1).content, "string", "no image on the router for V2");
  assert.match(v2.messages.at(-1).content, /"title":"We","author":"Yevgeny Zamyatin"/);
});

test("V2 router down -> Gemini gets the enrich prompt with the image", async (t) => {
  const router = await startRouter((body, n) => (n === 1 ? completion(JSON.stringify(ref.cover.responses[0])) : failure(503)));
  t.after(router.close);
  const { llm, direct } = routerLlm(router);

  await extractBookFromImage(imageBuffer(), ref.cover.mimeType, { llm });
  assert.equal(direct.calls.length, 1);
  assert.equal(direct.calls[0].kind, "vision");
  assert.equal(direct.calls[0].b64, ref.cover.imageBase64);
  assert.match(direct.calls[0].prompt, /^Enrich extracted book info\./);
});

test("V2 failure is swallowed: base item returned, error recorded for debug", async (t) => {
  const router = await startRouter((body, n) => (n === 1 ? completion(JSON.stringify(ref.cover.responses[0])) : failure(400, "bad")));
  t.after(router.close);
  const { llm } = routerLlm(router);

  const result = await extractBookFromImage(imageBuffer(), ref.cover.mimeType, { llm });
  assert.equal(result.items[0].title, "We");
  assert.equal(result.items[0].title_ru, null);
  assert.deepEqual(result.items[0].variants, ["We Yevgeny Zamyatin", "We"]);
  assert.equal(result.llm[1].step, "enrich");
  assert.match(result.llm[1].error, /400/);
});

// ---------- router answers that are valid JSON but don't identify anything ----------

// Comparison run 2026-10-06, row 3: openrouter/nvidia/nemotron-3-super-120b
// named the author but no title - with a non-empty query, so a plain
// "title or query" check would have let it through.
const ROW3_ROUTER_ANSWER =
  '{"query": "boy wizard scar magic school", "title": null, "author": "J.K. Rowling", "title_ru": null, "author_ru": "Джоан Роулинг", "confidence": 0.7}';

test("T1 router: author without a title -> JSON retry -> Gemini (comparison row 3)", async (t) => {
  const router = await startRouter(() => completion(ROW3_ROUTER_ANSWER, "openrouter/nvidia/nemotron-3-super-120b-a12b:free"));
  t.after(router.close);
  const gemini = { query: "boy wizard scar magic school", title: "Harry Potter", author: "J.K. Rowling", title_ru: "Гарри Поттер", author_ru: "Джоан Роулинг", confidence: 1 };
  const { llm, direct } = routerLlm(router, JSON.stringify(gemini));

  const { query, llm: steps } = await extractBookQueryFromText("book about a boy wizard with a scar who goes to a magic school", { llm });

  assert.equal(query.title, "Harry Potter");
  assert.equal(query.title_ru, "Гарри Поттер");
  assert.equal(router.requests.length, 2, "first answer + JSON-only retry");
  assert.equal(direct.calls.length, 1);
  assert.deepEqual(
    steps[0].attempts.map((a) => [a.via, a.error]),
    [
      ["freellmapi", "(root): author without a title"],
      ["freellmapi", "(root): author without a title"],
      ["direct", null],
    ]
  );
});

test("T1 router: neither title nor query -> Gemini; Gemini's own empty answer still means 'Мало деталей'", async (t) => {
  const empty = { query: "", title: null, author: null, title_ru: null, author_ru: null, confidence: 0 };
  const router = await startRouter(() => completion(JSON.stringify(empty)));
  t.after(router.close);
  const { llm, direct } = routerLlm(router, JSON.stringify(empty));

  const { query, llm: steps } = await extractBookQueryFromText("asdf", { llm });
  assert.equal(direct.calls.length, 1, "router answer rejected");
  assert.equal(query.query, "", "Gemini's answer accepted as before -> handleFindQuery replies 'Мало деталей'");
  assert.match(steps[0].attempts[0].error, /neither a title nor a query/);

  const { llm: directOnly } = directLlm([empty]);
  const { query: q2 } = await extractBookQueryFromText("asdf", { llm: directOnly });
  assert.equal(q2.query, "");
});

test("V1 router: item without a title -> Gemini; on the Gemini path it's accepted as before", async (t) => {
  const noTitle = { items: [{ title: "", author: "Джоан Роулинг", isbn: null, confidence: 0.9, evidence: [] }] };
  const router = await startRouter(() => completion(JSON.stringify(noTitle)));
  t.after(router.close);
  const { llm, direct } = routerLlm(router, JSON.stringify(ref.cover.responses[0]));

  const result = await extractBookFromImage(imageBuffer(), ref.cover.mimeType, { llm });
  assert.equal(direct.calls[0].kind, "vision");
  assert.equal(result.items[0].title, "We");
  assert.match(result.llm[0].attempts[0].error, /item without a title/);

  const { llm: directOnly } = directLlm([noTitle, {}]);
  const direct2 = await extractBookFromImage(imageBuffer(), ref.cover.mimeType, { llm: directOnly });
  assert.equal(direct2.items[0].title, "", "photoHandler then replies 'Не уверен'");
});

// ---------- zod leniency ----------

test("BookQuerySchema: missing/empty/'unknown' -> null, confidence normalized, query required", () => {
  assert.deepEqual(BookQuerySchema.parse({ query: " мы замятин ", author: "Unknown", title_ru: "", confidence: "97%" }), {
    query: "мы замятин",
    title: null,
    author: null,
    title_ru: null,
    author_ru: null,
    confidence: 0.97,
  });
  assert.equal(BookQuerySchema.parse({ query: "x" }).confidence, 0);
  assert.equal(BookQuerySchema.parse({ query: "x", author: ["A", "B"], confidence: 0.5 }).author, "A, B");
  assert.equal(BookQuerySchema.safeParse({ title: "Мы", confidence: 0.9 }).success, false);
  assert.equal(BookQuerySchema.safeParse({ query: "x", confidence: "high" }).success, false);
});

test("CoverExtractSchema: bare item/array accepted, truncation leftovers dropped, title required", () => {
  const item = { title: " Мы ", author: null, isbn: null, confidence: 0.9, evidence: "МЫ" };
  const expected = { items: [{ title: "Мы", author: null, isbn: null, confidence: 0.9, evidence: ["МЫ"] }] };
  assert.deepEqual(CoverExtractSchema.parse(item), expected);
  assert.deepEqual(CoverExtractSchema.parse([item]), expected);
  assert.deepEqual(CoverExtractSchema.parse({ items: [item, {}] }), expected);
  assert.deepEqual(CoverExtractSchema.parse({ items: [] }), { items: [] });
  assert.equal(CoverExtractSchema.safeParse({ items: [{ name: "Мы", confidence: 0.9 }] }).success, false);
  assert.equal(CoverExtractSchema.safeParse({ book: "Мы" }).success, false);
});

test("EnrichSchema: everything optional; a one-element array is unwrapped", () => {
  const expected = { title_en: null, author_en: null, title_ru: "Мы", author_ru: null, variants: [] };
  assert.deepEqual(EnrichSchema.parse({ title_ru: "Мы" }), expected);
  // Gemini answered [{...}] once despite the OBJECT responseSchema (comparison row 11).
  assert.deepEqual(EnrichSchema.parse([{ title_ru: "Мы" }]), expected);
  assert.equal(EnrichSchema.safeParse([{ title_ru: "Мы" }, { title_ru: "Мы" }]).success, false);
});

test("schema helpers derive JSON Schema and a prompt shape from a Gemini schema", () => {
  const gemini = {
    type: "OBJECT",
    properties: {
      title: { type: "STRING", nullable: true },
      items: { type: "ARRAY", items: { type: "OBJECT", properties: { c: { type: "NUMBER" } } } },
      tags: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["title"],
  };
  assert.deepEqual(toJsonSchema(gemini), {
    type: "object",
    properties: {
      title: { type: ["string", "null"] },
      items: { type: "array", items: { type: "object", properties: { c: { type: "number" } } } },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["title"],
  });
  assert.equal(describeShape(gemini), '{"title": string|null, "items": [{"c": number}], "tags": string[]}');
});
