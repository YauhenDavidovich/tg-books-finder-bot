import { parseJsonLoose } from "./gemini/jsonExtract.js";
import { fetchWithTimeout } from "./core/fetchWithTimeout.js";

function readAllParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildPrompt(userText) {
  return (
    "You extract book search data from a user's description.\n\n" +
    "Field rules:\n" +
    "- query: 2–6 words, must be useful for searching a book, include key nouns, no filler words like book/story/novel.\n" +
    "- title: exact title ONLY if you are very sure, otherwise null. Use whatever language you are most confident is the exact title (do not translate unnecessarily).\n" +
    "- author: exact author ONLY if you are very sure, otherwise null.\n" +
    "- title_ru: the Russian title of the same work, if you know one (translated or original). If title is already Russian, repeat it here. Otherwise null.\n" +
    '- author_ru: the author\'s name in Russian/Cyrillic spelling, if you know it (e.g. "Стивен Кинг" for "Stephen King"). Otherwise null.\n' +
    "- confidence: 0.9–1.0 famous clearly identified, 0.6–0.8 strong guess, 0.3–0.5 weak guess, 0.0–0.2 almost no idea.\n\n" +
    "Important behavior:\n" +
    "- NEVER invent a fake title or author.\n" +
    "- If unsure, still produce the best possible query.\n\n" +
    "User description:\n" +
    "```text\n" +
    String(userText || "") +
    "\n```"
  );
}

// Enforced natively via generationConfig.responseSchema below - Gemini's API
// then guarantees every field is present with the right type, instead of
// only being told via prompt text to include them (which it wasn't reliably
// doing: title_ru/author_ru were silently omitted in practice despite the
// prompt explicitly saying "NEVER omit fields").
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    query: { type: "STRING" },
    title: { type: "STRING", nullable: true },
    author: { type: "STRING", nullable: true },
    title_ru: { type: "STRING", nullable: true },
    author_ru: { type: "STRING", nullable: true },
    confidence: { type: "NUMBER" },
  },
  required: ["query", "title", "author", "title_ru", "author_ru", "confidence"],
};

async function geminiCallRaw({ apiKey, prompt, maxOutputTokens }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });

  const rawBody = await res.text();

  // Если Gemini вернул 4xx/5xx, отдаём raw как есть
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      rawBody,
      finishReason: null,
      candidateText: "",
      usageMetadata: null,
    };
  }

  let data = null;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return {
      ok: true,
      status: res.status,
      rawBody,
      finishReason: null,
      candidateText: "",
      usageMetadata: null,
    };
  }

  const cand = data?.candidates?.[0];
  const finishReason = cand?.finishReason || null;
  const usageMetadata = data?.usageMetadata || null;
  const candidateText = readAllParts(cand?.content?.parts);

  return {
    ok: true,
    status: res.status,
    rawBody,
    finishReason,
    candidateText,
    usageMetadata,
  };
}

// Для /gdebug: показать ровно то, что вернул Gemini
export async function geminiDebugBookQueryFromText(userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  const prompt = buildPrompt(userText);

  return geminiCallRaw({
    apiKey,
    prompt,
    maxOutputTokens: 1024,
  });
}

// Parses an already-fetched geminiCallRaw() result. Split out from
// geminiExtractBookQueryFromText so a caller that already fetched the raw
// response (e.g. for a debug preview) can parse that same response instead
// of making a second, independent Gemini call - two separate calls aren't
// guaranteed to agree (Gemini 2.5 Flash's "thinking" adds variance even at
// temperature 0), which previously let the debug preview and the actual
// search silently disagree.
export function parseBookQueryResult(r) {
  if (!r.ok) {
    throw new Error(`Gemini error: ${r.status}\n${r.rawBody}`);
  }

  if (!r.candidateText) {
    throw new Error(
      `Gemini returned empty candidateText.\nfinishReason=${r.finishReason || "-"}\nraw:\n${(r.rawBody || "").slice(0, 1200)}`
    );
  }

  // Same strip/extract/repair pipeline used by geminiVision.js, so a stray
  // markdown fence or a truncated response doesn't crash text search.
  const json = parseJsonLoose(r.candidateText);

  // минимальная нормализация типов, без умничанья
  return {
    query: String(json.query || ""),
    title: json.title ?? null,
    author: json.author ?? null,
    title_ru: json.title_ru ?? null,
    author_ru: json.author_ru ?? null,
    confidence: Number(json.confidence ?? 0) || 0,
  };
}

// Основная функция: ничего не чиним, просто parse как есть
export async function geminiExtractBookQueryFromText(userText) {
  const r = await geminiDebugBookQueryFromText(userText);
  return parseBookQueryResult(r);
}