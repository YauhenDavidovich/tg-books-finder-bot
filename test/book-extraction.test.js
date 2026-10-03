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

function routerLlm(router) {
  const calls = [];
  const llm = createLlm({ baseURL: router.baseURL, apiKey: "k", visionModel: "auto:vision", logger: silentLogger });
  llm.setDirectFallback({
    text: async (prompt, opts) => {
      calls.push({ kind: "text", prompt, opts });
      return "{}";
    },
    vision: async (b64, mimeType, prompt, opts) => {
      calls.push({ kind: "vision", b64, prompt, opts });
      return "{}";
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

test("EnrichSchema: everything optional", () => {
  assert.deepEqual(EnrichSchema.parse({ title_ru: "Мы" }), {
    title_en: null,
    author_en: null,
    title_ru: "Мы",
    author_ru: null,
    variants: [],
  });
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
