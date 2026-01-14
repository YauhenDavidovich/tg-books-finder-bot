import fetch from "node-fetch";

function stripCodeFences(s) {
  return (s || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function extractJsonObject(s) {
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

function readAllParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

// пытаемся восстановить обрезанный JSON: закрываем кавычки, ] и }
function tryRepairTruncatedJson(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str.startsWith("{")) return null;

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
    }
  }

  let repaired = str;

  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, "");
  while (stack.length) repaired += stack.pop();
  if (!repaired.endsWith("}")) repaired += "}";

  return repaired;
}

function uniqStrings(arr) {
  return [...new Set((arr || []).map((s) => String(s || "").trim()).filter(Boolean))];
}

function collapseSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function isBadQuery(q) {
  const s = collapseSpaces(q);
  if (!s) return true;
  if (s.length < 8) return true; // "Стивен"
  if (s.split(" ").length < 2) return true; // одно слово
  return false;
}

function buildFallbackQueryFromUserText(userText) {
  const s = collapseSpaces(userText).slice(0, 160);

  const stop = new Set([
    "книга","книгу","книги","роман","повесть","рассказ",
    "про","о","об","что","где","который","которая","которые",
    "и","или","в","на","из","у","по","для","с","со","без",
    "это","этот","эта","эти","тот","та","те","там","тут",
    "очень","просто","типа","вроде"
  ]);

  const tokens = s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => t.length >= 3)
    .filter((t) => !stop.has(t));

  const uniq = [...new Set(tokens)].slice(0, 10);
  const q = uniq.join(" ").trim();

  return q.length >= 8 && q.split(" ").length >= 2 ? q : s;
}

async function geminiCallJson({ apiKey, prompt, maxOutputTokens }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens,
      },
    }),
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`Gemini error: ${res.status} ${raw}`);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned non-JSON body. Preview:\n${raw.slice(0, 800)}`);
  }

  const cand = data?.candidates?.[0];
  const finishReason = cand?.finishReason || null;

  const candidateText = readAllParts(cand?.content?.parts);
  const cleaned = stripCodeFences(candidateText);

  // 1) прямой JSON.parse
  try {
    return { json: JSON.parse(cleaned), finishReason, usageMetadata: data?.usageMetadata || null };
  } catch {}

  // 2) вырезать объект, если есть закрывающая }
  const jsonOnly = extractJsonObject(cleaned);
  if (jsonOnly) {
    try {
      return { json: JSON.parse(jsonOnly), finishReason, usageMetadata: data?.usageMetadata || null };
    } catch {}
  }

  // 3) попытка починить обрезанный JSON
  const repaired = tryRepairTruncatedJson(cleaned);
  if (repaired) {
    try {
      return { json: JSON.parse(repaired), finishReason, usageMetadata: data?.usageMetadata || null };
    } catch {}
  }

  const preview = cleaned.slice(0, 900);
  const meta = JSON.stringify(
    {
      finishReason,
      usageMetadata: data?.usageMetadata || null,
      candidateTextPreview: candidateText.slice(0, 1200),
      rawBodyPreview: raw.slice(0, 1200),
    },
    null,
    2
  );

  throw new Error(`No JSON in Gemini response. Preview:\n${preview}\n\nMeta:\n${meta}`);
}

export async function geminiExtractBookQueryFromText(userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  // --- STEP 1: минимальный JSON, чтобы не ловить MAX_TOKENS
  const prompt1 =
    "Return ONLY minified JSON. No markdown.\n" +
    'Schema: {"query":string,"title":string|null,"author":string|null,"confidence":number}\n' +
    "Rules:\n" +
    "- Do not invent exact title/author.\n" +
    "- query must include at least 2 words when possible.\n" +
    "- If too little info, return confidence < 0.5.\n" +
    "Input:\n" +
    userText;

  const r1 = await geminiCallJson({ apiKey, prompt: prompt1, maxOutputTokens: 180 });
  const base = r1.json || {};

  let query = String(base.query || "");
  let confidence = Number(base.confidence ?? 0) || 0;

  const baseResult = {
    query,
    title: base.title ?? null,
    author: base.author ?? null,
    confidence,
    keywords: [],
    tags: [],
    query_ru: null,
    title_ru: null,
    author_ru: null,
    variants: uniqStrings([
      base.title && base.author ? `${base.title} ${base.author}` : null,
      base.title,
      base.query,
    ]),
  };

  // --- FIX: если query плохой (короткий/одно слово), заменяем на фолбэк
  if (isBadQuery(baseResult.query)) {
    baseResult.query = buildFallbackQueryFromUserText(userText);
    baseResult.confidence = Math.max(Number(baseResult.confidence || 0), 0.55);
  } else {
    // если модель дала query, но confidence=0, это часто “не оценил”, а не “нет инфы”
    if (baseResult.query && baseResult.confidence === 0) {
      baseResult.confidence = 0.55;
    }
  }

  // variants тоже обновим, если query поменялся
  baseResult.variants = uniqStrings([
    baseResult.title && baseResult.author ? `${baseResult.title} ${baseResult.author}` : null,
    baseResult.title,
    baseResult.query,
  ]);

  if (!baseResult.query) return baseResult;

  // --- STEP 2: RU + варианты для Флибусты + keywords/tags
  // запускаем, если query не пустой и не “плохой”
  if (isBadQuery(baseResult.query)) return baseResult;

  const prompt2 =
    "Return ONLY minified JSON. No markdown.\n" +
    'Schema: {"query_ru":string|null,"title_ru":string|null,"author_ru":string|null,"keywords":string[],"tags":string[],"variants":string[]}\n' +
    "Rules:\n" +
    "- Provide Russian versions if appropriate.\n" +
    "- keywords 4-7, tags 4-7.\n" +
    "- variants 6-10, each <= 80 chars, mix EN/RU.\n" +
    "Base:\n" +
    JSON.stringify({ query: baseResult.query, title: baseResult.title, author: baseResult.author }) +
    "\nUser input:\n" +
    userText;

  let enrich = {};
  try {
    const r2 = await geminiCallJson({ apiKey, prompt: prompt2, maxOutputTokens: 320 });
    enrich = r2.json || {};
  } catch {
    enrich = {};
  }

  const keywords = Array.isArray(enrich.keywords) ? enrich.keywords.slice(0, 7) : [];
  const tags = Array.isArray(enrich.tags) ? enrich.tags.slice(0, 8) : [];

  const variants = uniqStrings([
    ...(Array.isArray(enrich.variants) ? enrich.variants : []),
    ...baseResult.variants,
    enrich.title_ru && enrich.author_ru ? `${enrich.title_ru} ${enrich.author_ru}` : null,
    enrich.title_ru,
    enrich.query_ru,
    // на всякий
    userText
  ]);

  return {
    ...baseResult,
    keywords,
    tags,
    query_ru: enrich.query_ru ?? null,
    title_ru: enrich.title_ru ?? null,
    author_ru: enrich.author_ru ?? null,
    variants,
  };
}