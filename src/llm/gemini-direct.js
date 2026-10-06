// Direct Gemini API calls - the request shape the bot used before routing
// through FreeLLMAPI. Kept as the reference behavior and registered as the
// LLM client's fallback (setDirectFallback in index.js).
import { fetchWithTimeout } from "../core/fetchWithTimeout.js";

export const GEMINI_MODEL = "gemini-2.5-flash";

function readAllParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function generateContent(parts, { system, geminiSchema, geminiMaxTokens, geminiThinkingBudget } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // The router-side system prompt spells out the JSON shape for models
      // without native schema support. With a responseSchema Gemini doesn't
      // need it, and leaving it out keeps these requests identical to the
      // pre-router ones.
      ...(system && !geminiSchema ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0,
        ...(geminiMaxTokens ? { maxOutputTokens: geminiMaxTokens } : {}),
        // gemini-2.5-flash thinks by default, and thinking tokens count
        // against maxOutputTokens - small budgets need it off (0).
        ...(geminiThinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: geminiThinkingBudget } } : {}),
        ...(geminiSchema ? { responseMimeType: "application/json", responseSchema: geminiSchema } : {}),
      },
    }),
  });

  const rawBody = await res.text();
  if (!res.ok) throw new Error(`Gemini error: ${res.status} ${rawBody}`);

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`Gemini returned non-JSON body. Preview:\n${rawBody.slice(0, 800)}`);
  }

  const cand = data?.candidates?.[0];
  return { text: readAllParts(cand?.content?.parts), model: GEMINI_MODEL, finishReason: cand?.finishReason || null };
}

/** (prompt, opts) → { text, model, finishReason } */
export function geminiText(prompt, opts) {
  return generateContent([{ text: prompt }], opts);
}

/** (imageBase64, mimeType, prompt, opts) → { text, model, finishReason } */
export function geminiVision(imageBase64, mimeType, prompt, opts) {
  return generateContent([{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }], opts);
}
