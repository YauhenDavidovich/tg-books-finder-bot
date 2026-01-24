import fetch from "node-fetch";

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
    "Return ONLY valid minified JSON.\n" +
    "No markdown. No explanations. No text before or after JSON.\n\n" +
    'Schema: {"query":string,"title":string|null,"author":string|null,"confidence":number}\n\n' +
    "Field rules:\n" +
    "- query: 2–6 words, must be useful for searching a book, include key nouns, no filler words like book/story/novel.\n" +
    "- title: exact title ONLY if you are very sure, otherwise null.\n" +
    "- author: exact author ONLY if you are very sure, otherwise null.\n" +
    "- confidence: 0.9–1.0 famous clearly identified, 0.6–0.8 strong guess, 0.3–0.5 weak guess, 0.0–0.2 almost no idea.\n\n" +
    "Important behavior:\n" +
    "- NEVER return empty JSON.\n" +
    "- NEVER omit fields.\n" +
    "- NEVER invent a fake title or author.\n" +
    "- If unsure, still produce the best possible query.\n\n" +
    "User description:\n" +
    "```text\n" +
    String(userText || "") +
    "\n```"
  );
}

async function geminiCallRaw({ apiKey, prompt, maxOutputTokens }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens },
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

// Основная функция: ничего не чиним, просто parse как есть
export async function geminiExtractBookQueryFromText(userText) {
  const r = await geminiDebugBookQueryFromText(userText);

  // если запрос вообще не удался, кидаем ошибку с rawBody
  if (!r.ok) {
    throw new Error(`Gemini error: ${r.status}\n${r.rawBody}`);
  }

  // если candidateText пустой, тоже ошибка
  if (!r.candidateText) {
    throw new Error(
      `Gemini returned empty candidateText.\nfinishReason=${r.finishReason || "-"}\nraw:\n${(r.rawBody || "").slice(0, 1200)}`
    );
  }

  // тут принципиально: без strip/extract/repair
  const json = JSON.parse(r.candidateText);

  // минимальная нормализация типов, без умничанья
  return {
    query: String(json.query || ""),
    title: json.title ?? null,
    author: json.author ?? null,
    confidence: Number(json.confidence ?? 0) || 0,
  };
}