import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLlmSteps } from "../src/llm/debug.js";

const attempt = (extra) => ({ via: "freellmapi", model: "google/gemini-3.5-flash", latencyMs: 900, finishReason: "stop", note: null, fallbackReason: null, error: null, ...extra });

test("one line per step with via, model, latency", () => {
  const text = formatLlmSteps([
    { step: "cover", attempts: [attempt({ latencyMs: 15800 })] },
    { step: "enrich", attempts: [attempt({ model: "groq/llama-3.3-70b", latencyMs: 640 })] },
  ]);
  assert.equal(
    text,
    "LLM DEBUG\n" +
      "cover: via=freellmapi model=google/gemini-3.5-flash 15800ms finish=stop\n" +
      "enrich: via=freellmapi model=groq/llama-3.3-70b 640ms finish=stop"
  );
});

test("retries, fallbacks and errors are spelled out", () => {
  const text = formatLlmSteps([
    {
      step: "cover",
      attempts: [
        attempt({ model: "qwen/qwen2.5-vl", error: "items.0.title: Invalid input" }),
        attempt({ model: "qwen/qwen2.5-vl", note: "retry: JSON only", error: "No JSON object found in LLM response." }),
        attempt({ via: "direct", model: "gemini-2.5-flash", note: "fallback after unusable JSON", fallbackReason: "unusable JSON from router" }),
      ],
    },
    { step: "enrich", attempts: [], error: "router 400: bad" },
  ]);
  assert.match(text, /cover #1: via=freellmapi model=qwen\/qwen2\.5-vl .*\n  ✗ items\.0\.title: Invalid input/);
  assert.match(text, /cover #2: .*\[retry: JSON only\]\n  ✗ No JSON object found/);
  assert.match(text, /cover #3: via=direct model=gemini-2\.5-flash .*\[fallback after unusable JSON\]\n  fallback: unusable JSON from router/);
  assert.match(text, /enrich: ✗ router 400: bad/);
});

test("withText appends the raw response", () => {
  const text = formatLlmSteps([{ step: "text", attempts: [attempt()], text: '{"query":"мы"}' }], { withText: true });
  assert.match(text, /\n\ntext response:\n\{"query":"мы"\}$/);
});
