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

// более умный repair: умеет чинить обрезы вида {"query":"x","title":
function tryRepairTruncatedJson(s) {
  if (!s) return null;
  let str = String(s).trim();
  if (!str.startsWith("{")) return null;

  // если оборвалось на ":" или на '"key":' без значения, откатимся до предыдущей пары
  while (true) {
    const t = str.trim();

    // ...,"key":
    if (/[,{]\s*"[^\"]+"\s*:\s*$/.test(t) || /:\s*$/.test(t)) {
      const lastComma = t.lastIndexOf(",");
      if (lastComma > 0) {
        str = t.slice(0, lastComma).trim();
        continue;
      }
      str = "{}";
      break;
    }

    // ...,"key":"unterminated
    if (/,\s*"[^\"]+"\s*:\s*"[^\"]*$/.test(t)) {
      const lastComma = t.lastIndexOf(",");
      if (lastComma > 0) {
        str = t.slice(0, lastComma).trim();
        continue;
      }
      str = "{}";
      break;
    }

    break;
  }

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

  // убираем хвостовую запятую
  repaired = repaired.replace(/,\s*$/, "");

  while (stack.length) repaired += stack.pop();

  if (!repaired.endsWith("}")) repaired += "}";

  // страховка
  if (repaired === "{}}") repaired = "{}";
  if (repaired === "{") repaired = "{}";

  return repaired;
}

function collapseSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function isBadQuery(q) {
  const s = collapseSpaces(q);
  if (!s) return true;
  if (s.length < 6) return true; // было 8, это слишком жёстко
  if (s.split(" ").length < 1) return true;
  return false;
}

function buildFallbackQueryFromUserText(userText) {
  const s = collapseSpaces(userText).slice(0, 180);

  const stop = new Set([
    "книга",
    "книгу",
    "книги",
    "роман",
    "повесть",
    "рассказ",
    "про",
    "о",
    "об",
    "что",
    "где",
    "который",
    "которая",
    "которые",
    "и",
    "или",
    "в",
    "на",
    "из",
    "у",
    "по",
    "для",
    "с",
    "со",
    "без",
    "это",
    "этот",
    "эта",
    "эти",
    "тот",
    "та",
    "те",
    "там",
    "тут",
  ]);

  const tokens = s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => t.length >= 3)
    .filter((t) => !stop.has(t));

  const uniq = [...new Set(tokens)].slice(0, 9);
  const q = uniq.join(" ").trim();

  return q.length >= 6 ? q : s;
}

function detectAuthorFromText(userText) {
  const s = collapseSpaces(String(userText || ""));

  // RU: Имя Фамилия
  const ru = s.match(/(?:^|\s)([А-ЯЁ][а-яё]+)\s+([А-ЯЁ][а-яё]+)(?=\s|$)/);
  if (ru) return `${ru[1]} ${ru[2]}`;

  // EN: Name Surname
  const en = s.match(/(?:^|\s)([A-Z][a-z]+)\s+([A-Z][a-z]+)(?=\s|$)/);
  if (en) return `${en[1]} ${en[2]}`;

  return null;
}

// делаем вызов и возвращаем сразу и json, и сырые куски для дебага
async function geminiCall({ apiKey, prompt, maxOutputTokens }) {
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

  const raw = await res.text();
  if (!res.ok) throw new Error(`Gemini error: ${res.status} ${raw}`);

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // иногда Gemini возвращает не-JSON оболочку, но это редкость
    return { json: null, raw, candidateText: "", finishReason: null, usageMetadata: null };
  }

  const cand = data?.candidates?.[0];
  const finishReason = cand?.finishReason || null;
  const usageMetadata = data?.usageMetadata || null;

  const candidateText = readAllParts(cand?.content?.parts);
  const cleaned = stripCodeFences(candidateText);

  // 1) прямой parse
  try {
    return { json: JSON.parse(cleaned), raw, candidateText: cleaned, finishReason, usageMetadata };
  } catch {}

  // 2) вырезать объект
  const jsonOnly = extractJsonObject(cleaned);
  if (jsonOnly) {
    try {
      return { json: JSON.parse(jsonOnly), raw, candidateText: cleaned, finishReason, usageMetadata };
    } catch {}
  }

  // 3) repair
  const repaired = tryRepairTruncatedJson(cleaned);
  if (repaired) {
    try {
      return { json: JSON.parse(repaired), raw, candidateText: cleaned, finishReason, usageMetadata };
    } catch {}
  }

  return { json: null, raw, candidateText: cleaned, finishReason, usageMetadata };
}

// экспорт для /gdebug: можно показать, что вернул Gemini
export async function geminiDebugBookQueryFromText(userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  const prompt =
    "Return ONLY minified JSON. No markdown, no comments.\n" +
    'Schema: {"query":string,"title":string|null,"author":string|null,"query_ru":string|null,"title_ru":string|null,"author_ru":string|null,"confidence":number}\n' +
    "Rules:\n" +
    "- Do not invent exact title or author.\n" +
    "- query must be useful for book search (2–6 words).\n" +
    "- If not confident, set confidence < 0.5 but still return best guess.\n" +
    "Input:\n" +
    userText;

  return geminiCall({ apiKey, prompt, maxOutputTokens: 220 });
}

export async function geminiExtractBookQueryFromText(userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  // компактный prompt, чтобы не ловить MAX_TOKENS
  const prompt =
    "Return ONLY minified JSON. No markdown, no comments.\n" +
    'Schema: {"query":string,"title":string|null,"author":string|null,"query_ru":string|null,"title_ru":string|null,"author_ru":string|null,"confidence":number}\n' +
    "Rules:\n" +
    "- Do not invent exact title or author.\n" +
    "- query must be useful for book search (2–6 words).\n" +
    "- If not confident, set confidence < 0.5 but still return best guess.\n" +
    "Input:\n" +
    userText;

  const r = await geminiCall({
    apiKey,
    prompt,
    maxOutputTokens: 220,
  });

  const j = r.json || {};

  let query = String(j.query || "");
  let confidence = Number(j.confidence ?? 0) || 0;

  let title = j.title ?? null;
  let author = j.author ?? null;

  const query_ru = j.query_ru ?? null;
  const title_ru = j.title_ru ?? null;
  const author_ru = j.author_ru ?? null;

  if (!author) {
    const a = detectAuthorFromText(userText);
    if (a) author = a;
  }

  // если Gemini дал ерунду, строим fallback запрос
  if (isBadQuery(query)) {
    query = buildFallbackQueryFromUserText(userText);
    // не задираем уверенность слишком высоко, но и не ноль
    confidence = Math.max(confidence, 0.35);
  } else if (query && confidence === 0) {
    confidence = 0.35;
  }

  return {
    query,
    title,
    author,
    confidence,
    query_ru,
    title_ru,
    author_ru,
    keywords: [],
    tags: [],
    // полезно для диагностики в коде, но если не нужно, можешь удалить
    _gemini: {
      finishReason: r.finishReason || null,
      truncated: r.finishReason === "MAX_TOKENS",
    },
  };
}