import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { geminiText, geminiVision, GEMINI_MODEL } from "../src/llm/gemini-direct.js";

const realFetch = globalThis.fetch;
let calls;

function mockFetch(status, body) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}

const geminiAnswer = (text, finishReason = "STOP") => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason }],
});

beforeEach(() => {
  calls = [];
  process.env.GEMINI_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("schema call: temperature 0, budget, responseSchema, no system instruction", async () => {
  mockFetch(200, geminiAnswer('{"title":"Мы"}'));
  const schema = { type: "OBJECT", properties: { title: { type: "STRING" } }, required: ["title"] };

  const r = await geminiText("prompt", { system: "router-only rules", geminiSchema: schema, geminiMaxTokens: 1024 });

  assert.deepEqual(r, { text: '{"title":"Мы"}', model: GEMINI_MODEL, finishReason: "STOP" });
  assert.match(calls[0].url, /models\/gemini-2\.5-flash:generateContent\?key=test-key$/);
  assert.deepEqual(calls[0].body, {
    contents: [{ role: "user", parts: [{ text: "prompt" }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: "application/json", responseSchema: schema },
  });
});

test("vision call sends text then inline image", async () => {
  mockFetch(200, geminiAnswer("{}"));
  await geminiVision("QUJD", "image/jpeg", "read", { geminiMaxTokens: 320 });

  assert.deepEqual(calls[0].body.contents[0].parts, [{ text: "read" }, { inlineData: { mimeType: "image/jpeg", data: "QUJD" } }]);
  assert.deepEqual(calls[0].body.generationConfig, { temperature: 0, maxOutputTokens: 320 });
});

test("thinking budget is sent only when given (0 turns thinking off)", async () => {
  mockFetch(200, geminiAnswer("{}"));
  await geminiVision("QUJD", "image/jpeg", "read", { geminiMaxTokens: 320, geminiThinkingBudget: 0 });
  await geminiText("q", { geminiMaxTokens: 1024 });

  assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined);
});

test("without a schema the system prompt goes in as systemInstruction", async () => {
  mockFetch(200, geminiAnswer("hi"));
  await geminiText("q", { system: "be brief" });
  assert.deepEqual(calls[0].body.systemInstruction, { parts: [{ text: "be brief" }] });
});

test("empty candidate comes back as empty text with finishReason", async () => {
  mockFetch(200, { candidates: [{ finishReason: "MAX_TOKENS" }] });
  assert.deepEqual(await geminiText("q"), { text: "", model: GEMINI_MODEL, finishReason: "MAX_TOKENS" });
});

test("HTTP error and non-JSON body throw", async () => {
  mockFetch(503, "overloaded");
  await assert.rejects(geminiText("q"), /Gemini error: 503 overloaded/);

  mockFetch(200, "<html>");
  await assert.rejects(geminiText("q"), /non-JSON body/);
});

test("missing GEMINI_API_KEY throws", async () => {
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(geminiText("q"), /GEMINI_API_KEY is missing/);
});
