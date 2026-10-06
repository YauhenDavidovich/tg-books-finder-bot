// Live smoke test of the LLM layer with the settings from .env:
//   node scripts/llm-smoke.js [path/to/cover]   (default: first file in fixtures/)
// Prints via/model/latency and the parsed result for a plain chat call, a
// chatJson call (text search) and a visionJson call (cover).
//
// Failover check - an unreachable router must be answered by direct Gemini:
//   LLM_BASE_URL=http://127.0.0.1:9/v1 node scripts/llm-smoke.js
import "dotenv/config";
import path from "node:path";
import { config } from "../src/config.js";
import { chat, setDirectFallback } from "../src/llm/client.js";
import { geminiText, geminiVision } from "../src/llm/gemini-direct.js";
import { extractBookQueryFromText, extractBookFromImage } from "../src/llm/bookExtraction.js";
import { formatLlmSteps } from "../src/llm/debug.js";
import { listCoverFixtures, loadAsTelegramPhoto } from "./lib/fixtures.js";

setDirectFallback({ text: geminiText, vision: geminiVision });

function routerHost() {
  if (!config.LLM_BASE_URL) return "(not set)";
  try {
    const url = new URL(config.LLM_BASE_URL);
    return `${url.host}${url.pathname}`; // FreeLLMAPI serves the API under /v1
  } catch {
    // The value itself isn't printed: a mis-pasted line could hold a key.
    return `(set but not a valid URL, ${config.LLM_BASE_URL.length} chars)`;
  }
}

console.log(
  `provider=${config.LLM_PROVIDER} router=${routerHost()} model=${config.LLM_MODEL} ` +
    `vision_model=${config.LLM_VISION_MODEL} json_mode=${config.LLM_JSON_MODE} ` +
    `LLM_API_KEY=${config.LLM_API_KEY ? "set" : "MISSING"} GEMINI_API_KEY=${process.env.GEMINI_API_KEY ? "set" : "MISSING"}\n`
);

let failed = 0;

async function section(title, fn) {
  console.log(`=== ${title}`);
  try {
    await fn();
  } catch (err) {
    failed += 1;
    console.log(`FAILED: ${String(err?.message || err).slice(0, 600)}`);
    if (err?.attempts?.length) console.log(formatLlmSteps([{ step: "attempts", attempts: err.attempts }]));
  }
  console.log();
}

await section("chat (plain text)", async () => {
  const r = await chat("Reply with exactly one word: pong");
  console.log(`via=${r.via} model=${r.model} ${r.latencyMs}ms finish=${r.finishReason ?? "-"}${r.fallbackReason ? ` fallback: ${r.fallbackReason}` : ""}`);
  console.log(`text: ${JSON.stringify(r.text.trim().slice(0, 200))}`);
});

await section("chatJson (text search, T1)", async () => {
  const { query, llm } = await extractBookQueryFromText("антиутопия про стеклянный город и нумера, автор вроде Замятин");
  console.log(formatLlmSteps(llm));
  console.log(JSON.stringify(query, null, 2));
});

const coverPath = process.argv[2] || listCoverFixtures()[0];
await section(`visionJson (cover, V1 + V2): ${coverPath ? path.basename(coverPath) : "no fixture"}`, async () => {
  if (!coverPath) throw new Error("No cover: pass a path or put an image into fixtures/");
  const { items, llm } = await extractBookFromImage(loadAsTelegramPhoto(coverPath), "image/jpeg");
  console.log(formatLlmSteps(llm));
  console.log(JSON.stringify(items[0] ?? "(no items)", null, 2));
});

console.log(failed ? `${failed} section(s) failed` : "all sections passed");
process.exit(failed ? 1 : 0);
