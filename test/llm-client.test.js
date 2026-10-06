import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createLlm, JSON_RULE, LlmJsonError } from "../src/llm/client.js";
import { startRouter, completion, failure } from "./helpers/fakeRouter.js";

function makeDirect(answer = '{"title":"from-gemini"}') {
  const calls = [];
  return {
    calls,
    text: async (prompt, opts) => {
      calls.push({ kind: "text", prompt, opts });
      return { text: answer, model: "gemini-2.5-flash", finishReason: "STOP" };
    },
    vision: async (b64, mimeType, prompt, opts) => {
      calls.push({ kind: "vision", b64, mimeType, prompt, opts });
      return { text: answer, model: "gemini-2.5-flash", finishReason: "STOP" };
    },
  };
}

function makeLogger() {
  const lines = [];
  return { lines, warn: (m) => lines.push(m), log: (m) => lines.push(m) };
}

function makeLlm(routerUrl, extra = {}) {
  const direct = makeDirect(extra.directAnswer);
  const logger = makeLogger();
  const llm = createLlm({ baseURL: routerUrl, apiKey: "freellmapi-test", timeoutMs: 3000, logger, ...extra });
  llm.setDirectFallback(direct);
  return { llm, direct, logger };
}

const TitleSchema = z.object({ title: z.string() });

test("chatJson via router: data, model from X-Routed-Via, request knobs", async (t) => {
  const router = await startRouter(() => completion('{"title":"Мы"}'));
  t.after(router.close);
  const { llm, direct } = makeLlm(router.baseURL);

  const r = await llm.chatJson("find the book", {
    system: "You identify books.",
    schema: TitleSchema,
    jsonSchema: { type: "object", properties: { title: { type: "string" } } },
    schemaName: "book",
    maxTokens: 512,
    reasoningEffort: "minimal",
  });

  assert.deepEqual(r.data, { title: "Мы" });
  assert.equal(r.via, "freellmapi");
  assert.equal(r.model, "google/gemini-3.5-flash");
  assert.equal(r.attempts.length, 1);
  assert.equal(direct.calls.length, 0);

  const body = router.requests[0];
  assert.equal(body.model, "auto");
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 512);
  assert.equal(body.reasoning_effort, "minimal");
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.name, "book");
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /You identify books\./);
  assert.ok(body.messages[0].content.includes(JSON_RULE));
  assert.equal(body.messages[1].content, "find the book");
});

test("jsonMode json_object sends plain JSON mode", async (t) => {
  const router = await startRouter(() => completion('{"title":"Мы"}'));
  t.after(router.close);
  const { llm } = makeLlm(router.baseURL, { jsonMode: "json_object" });

  await llm.chatJson("q", { jsonSchema: { type: "object" } });
  assert.deepEqual(router.requests[0].response_format, { type: "json_object" });
});

test("vision sends the image as a data URL to the vision model", async (t) => {
  const router = await startRouter(() => completion('{"title":"Мы"}'));
  t.after(router.close);
  const { llm } = makeLlm(router.baseURL, { visionModel: "auto:vision" });

  await llm.visionJson("QUJD", "image/jpeg", "read the cover");
  const body = router.requests[0];
  assert.equal(body.model, "auto:vision");
  const parts = body.messages.at(-1).content;
  assert.deepEqual(parts[0], { type: "text", text: "read the cover" });
  assert.deepEqual(parts[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } });
});

test("broken LLM_BASE_URL -> answered by direct Gemini, reason logged", async () => {
  const { llm, direct, logger } = makeLlm("http://127.0.0.1:9/v1");

  const r = await llm.chatJson("q", { schema: TitleSchema });
  assert.equal(r.via, "direct");
  assert.equal(r.model, "gemini-2.5-flash");
  assert.deepEqual(r.data, { title: "from-gemini" });
  assert.match(r.fallbackReason, /router unreachable/);
  assert.equal(direct.calls.length, 1);
  assert.ok(logger.lines.some((l) => /text -> direct Gemini: router unreachable/.test(l)));
});

test("401/403/404/429/5xx fall back to direct, config errors with a hint", async (t) => {
  for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
    const router = await startRouter(() => failure(status));
    t.after(router.close);
    const { llm } = makeLlm(router.baseURL);
    const r = await llm.chat("q");
    assert.equal(r.via, "direct", `status ${status}`);
    assert.match(r.fallbackReason, new RegExp(`^router ${status}: upstream failed`));
  }
});

test("circuit breaker: 2 router failures in a row -> direct for 60s, then router again", async (t) => {
  let healthy = false;
  const router = await startRouter(() => (healthy ? completion('{"title":"ok"}') : failure(503)));
  t.after(router.close);
  let clock = 1_000_000;
  const { llm, logger } = makeLlm(router.baseURL, { now: () => clock });

  await llm.chat("1");
  await llm.chat("2");
  assert.equal(router.requests.length, 2);
  assert.ok(logger.lines.some((l) => /router failed 2 times in a row/.test(l)));

  const skipped = await llm.chat("3");
  assert.equal(router.requests.length, 2, "router not called while the circuit is open");
  assert.equal(skipped.fallbackReason, "router circuit open");

  healthy = true;
  clock += 60_000;
  const back = await llm.chat("4");
  assert.equal(back.via, "freellmapi");
  assert.equal(router.requests.length, 3);
});

test("a router success resets the failure count", async (t) => {
  let n = 0;
  const router = await startRouter(() => (++n % 2 === 1 ? failure(503) : completion("{}")));
  t.after(router.close);
  const { llm } = makeLlm(router.baseURL);

  for (let i = 0; i < 4; i++) await llm.chat(String(i)); // fail, ok, fail, ok
  assert.equal(router.requests.length, 4, "never tripped: failures were not consecutive");
});

test("400 falls back for vision only; text 400 is thrown", async (t) => {
  const router = await startRouter(() => failure(400, "model does not support images"));
  t.after(router.close);
  const { llm, direct } = makeLlm(router.baseURL);

  const r = await llm.vision("QUJD", "image/png", "read");
  assert.equal(r.via, "direct");
  assert.equal(direct.calls[0].kind, "vision");
  assert.equal(direct.calls[0].b64, "QUJD");

  await assert.rejects(llm.chat("q"), (err) => err.status === 400);
});

test("unusable JSON: router retry with JSON-only rule, then direct", async (t) => {
  const router = await startRouter(() => completion("I think this is Zamyatin's novel We."));
  t.after(router.close);
  const { llm, direct, logger } = makeLlm(router.baseURL);

  const r = await llm.chatJson("original prompt", { schema: TitleSchema });
  assert.equal(r.via, "direct");
  assert.deepEqual(r.data, { title: "from-gemini" });

  assert.equal(router.requests.length, 2);
  assert.equal(router.requests[0].messages.at(-1).content, "original prompt");
  assert.equal(router.requests[1].messages.at(-1).content, `original prompt\n\n${JSON_RULE}`);
  assert.equal(direct.calls[0].prompt, "original prompt", "Gemini gets the unmodified prompt");

  assert.deepEqual(
    r.attempts.map((a) => [a.via, a.note, Boolean(a.error)]),
    [
      ["freellmapi", null, true],
      ["freellmapi", "retry: JSON only", true],
      ["direct", "fallback after unusable JSON", false],
    ]
  );
  assert.ok(logger.lines.some((l) => /unusable JSON from freellmapi model=google\/gemini-3\.5-flash/.test(l)));
});

test("zod-invalid JSON counts as unusable; retry can fix it", async (t) => {
  const router = await startRouter((body, n) => completion(n === 1 ? '{"name":"Мы"}' : '{"title":"Мы"}'));
  t.after(router.close);
  const { llm, direct } = makeLlm(router.baseURL);

  const r = await llm.chatJson("q", { schema: TitleSchema });
  assert.equal(r.via, "freellmapi");
  assert.deepEqual(r.data, { title: "Мы" });
  assert.match(r.attempts[0].error, /title/);
  assert.equal(direct.calls.length, 0);
});

test("still unusable after direct -> LlmJsonError with all attempts", async (t) => {
  const router = await startRouter(() => completion("no json here"));
  t.after(router.close);
  const { llm } = makeLlm(router.baseURL, { directAnswer: "" });

  await assert.rejects(llm.chatJson("q", { schema: TitleSchema }), (err) => {
    assert.ok(err instanceof LlmJsonError);
    assert.equal(err.attempts.length, 3);
    assert.match(err.message, /direct gemini-2\.5-flash/);
    return true;
  });
});

test("direct answer that is unusable is not retried", async () => {
  const { llm, direct } = makeLlm("", { directAnswer: "nope" });
  await assert.rejects(llm.chatJson("q"), LlmJsonError);
  assert.equal(direct.calls.length, 1);
});

test("directImage: text on the router, vision with the image on Gemini", async (t) => {
  let down = false;
  const router = await startRouter(() => (down ? failure(503) : completion('{"title":"Мы"}')));
  t.after(router.close);
  const { llm, direct } = makeLlm(router.baseURL);
  const opts = { directImage: { base64: "QUJD", mimeType: "image/jpeg" } };

  await llm.chatJson("enrich", opts);
  assert.equal(typeof router.requests[0].messages.at(-1).content, "string", "router gets no image");
  assert.equal(router.requests[0].model, "auto");

  down = true;
  const r = await llm.chatJson("enrich", opts);
  assert.equal(r.via, "direct");
  assert.equal(direct.calls[0].kind, "vision");
  assert.equal(direct.calls[0].b64, "QUJD");
});

test("LLM_PROVIDER=direct never calls the router", async (t) => {
  const router = await startRouter(() => completion("{}"));
  t.after(router.close);
  const { llm, direct } = makeLlm(router.baseURL, { provider: "direct" });

  const r = await llm.chat("q");
  assert.equal(r.via, "direct");
  assert.equal(r.fallbackReason, null);
  assert.equal(router.requests.length, 0);
  assert.equal(direct.calls.length, 1);
});

test("LLM_PROVIDER=freellmapi never falls back", async (t) => {
  const router = await startRouter(() => failure(503));
  t.after(router.close);
  const { llm, direct } = makeLlm(router.baseURL, { provider: "freellmapi" });

  await assert.rejects(llm.chat("q"), (err) => err.status === 503);
  assert.equal(direct.calls.length, 0);
});

test("router config errors carry a hint in the fallback reason", async (t) => {
  const router = await startRouter(() => failure(401, "Invalid API key"));
  t.after(router.close);
  const { llm, logger } = makeLlm(router.baseURL);

  const r = await llm.chat("q");
  assert.equal(r.fallbackReason, "router 401: Invalid API key (check LLM_API_KEY)");
  assert.ok(logger.lines.some((l) => l.includes("router 401: Invalid API key (check LLM_API_KEY)")));
});

test("a non-API 200 (dashboard HTML, no /v1) is a router failure: no retries, straight to direct", async (t) => {
  const router = await startRouter(() => ({ html: "<!doctype html><html>dashboard</html>" }));
  t.after(router.close);
  const { llm, direct, logger } = makeLlm(router.baseURL);

  const r = await llm.chatJson("q", { schema: TitleSchema });
  assert.equal(r.via, "direct");
  assert.deepEqual(r.data, { title: "from-gemini" });
  assert.match(r.fallbackReason, /non-API response \(text\/html; charset=utf-8\) - check that LLM_BASE_URL ends with \/v1/);
  assert.equal(router.requests.length, 1, "no JSON retries against a page that isn't the API");
  assert.equal(r.attempts.length, 1);
  assert.equal(direct.calls.length, 1);

  await llm.chat("again");
  assert.ok(logger.lines.some((l) => /router failed 2 times in a row/.test(l)), "counts toward the breaker");
});

test("startup check: invalid or scheme-less LLM_BASE_URL -> direct only, with a warning", async () => {
  for (const baseURL of ["freellmapi-production-1395.up.railway.app", "localhost:3001/v1"]) {
    const { llm, direct, logger } = makeLlm(baseURL);
    const r = await llm.chat("q");
    assert.equal(r.via, "direct", baseURL);
    assert.equal(r.fallbackReason, "router not configured");
    assert.equal(direct.calls.length, 1);
    assert.ok(logger.lines.some((l) => /LLM_BASE_URL (is not a valid URL|must start with http)/.test(l) && l.endsWith("using direct Gemini only")), baseURL);
  }
});

test("startup check: a path without /v1 only warns, the router is still used", async (t) => {
  const router = await startRouter(() => completion("{}"));
  t.after(router.close);
  const { llm, logger } = makeLlm(router.baseURL.replace(/\/v1$/, ""));

  await llm.chat("q");
  assert.equal(router.requests.length, 1);
  assert.ok(logger.lines.some((l) => l.includes('LLM_BASE_URL path is "/" - FreeLLMAPI serves its API under /v1')));
});

test("routerSchema applies to router answers only", async (t) => {
  const router = await startRouter(() => completion('{"title":""}'));
  t.after(router.close);
  const { llm, direct } = makeLlm(router.baseURL, { directAnswer: '{"title":""}' });
  const strict = TitleSchema.refine((d) => d.title, { message: "empty title" });

  const r = await llm.chatJson("q", { schema: TitleSchema, routerSchema: strict });
  assert.equal(r.via, "direct");
  assert.deepEqual(r.data, { title: "" }, "Gemini's answer is validated with the plain schema");
  assert.equal(direct.calls.length, 1);
  assert.deepEqual(r.attempts.map((a) => a.error), ["(root): empty title", "(root): empty title", null]);
});

test("separate timeouts: a slow router times out text but not vision", async (t) => {
  const router = await startRouter(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return completion('{"title":"Мы"}');
  });
  t.after(router.close);
  const { llm } = makeLlm(router.baseURL, { timeoutMs: 100, visionTimeoutMs: 2000 });

  const text = await llm.chat("q");
  assert.equal(text.via, "direct");
  assert.equal(text.fallbackReason, "router timeout");

  const vision = await llm.vision("QUJD", "image/jpeg", "read");
  assert.equal(vision.via, "freellmapi");
});

test("config errors fail fast", () => {
  assert.throws(() => createLlm({ provider: "openai" }), /Unknown LLM_PROVIDER/);
  assert.throws(() => createLlm({ provider: "freellmapi" }), /needs a working router config: LLM_BASE_URL\/LLM_API_KEY not set/);
  assert.throws(
    () => createLlm({ provider: "freellmapi", baseURL: "freellmapi.example.com", apiKey: "k" }),
    /needs a working router config: LLM_BASE_URL is not a valid URL/
  );
});

test("default mode without router config uses direct and says so once", async () => {
  const logger = makeLogger();
  const llm = createLlm({ logger });
  llm.setDirectFallback(makeDirect());
  const r = await llm.chat("q");
  assert.equal(r.via, "direct");
  assert.equal(logger.lines.filter((l) => /not set - using direct Gemini only/.test(l)).length, 1);
});
