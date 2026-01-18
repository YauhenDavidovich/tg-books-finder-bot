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

function collapseSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function isBadQuery(q) {
  const s = collapseSpaces(q);
  if (!s) return true;
  if (s.length < 8) return true;
  if (s.split(" ").length < 2) return true;
  return false;
}

function buildFallbackQueryFromUserText(userText) {
  const s = collapseSpaces(userText).slice(0, 160);

  const stop = new Set([
    "книга","книгу","книги","роман","повесть","рассказ",
    "про","о","об","что","где","который","которая","которые",
    "и","или","в","на","из","у","по","для","с","со","без",
    "это","этот","эта","эти","тот","та","те","там","тут"
  ]);

  const tokens = s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => t.length >= 3)
    .filter((t) => !stop.has(t));

  const uniq = [...new Set(tokens)].slice(0, 8);
  const q = uniq.join(" ").trim();

  return q.length >= 8 && q.split(" ").length >= 2 ? q : s;
}

function detectAuthorFromText(userText) {
  const s = collapseSpaces(String(userText || ""));

  const ru = s.match(/(?:^|\s)([А-ЯЁ][а-яё]+)\s+([А-ЯЁ][а-яё]+)(?=\s|$)/);
  if (ru) return `${ru[1]} ${ru[2]}`;

  const en = s.match(/(?:^|\s)([A-Z][a-z]+)\s+([A-Z][a-z]+)(?=\s|$)/);
  if (en) return `${en[1]} ${en[2]}`;

  return null;
}

async function geminiCallJson({ apiKey, prompt, maxOutputTokens }) {
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

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned non-JSON body:\n${raw.slice(0, 800)}`);
  }

  const cand = data?.candidates?.[0];
  const candidateText = readAllParts(cand?.content?.parts);
  const cleaned = stripCodeFences(candidateText);

  try {
    return JSON.parse(cleaned);
  } catch {}

  const jsonOnly = extractJsonObject(cleaned);
  if (jsonOnly) {
    try {
      return JSON.parse(jsonOnly);
    } catch {}
  }

  const repaired = tryRepairTruncatedJson(cleaned);
  if (repaired) {
    try {
      return JSON.parse(repaired);
    } catch {}
  }

  throw new Error(
    `No JSON in Gemini response.\nPreview:\n${cleaned.slice(0, 800)}`
  );
}

export async function geminiExtractBookQueryFromText(userText) {
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

  const j = await geminiCallJson({
    apiKey,
    prompt,
    maxOutputTokens: 280,
  });

  let query = String(j.query || "");
  let confidence = Number(j.confidence ?? 0) || 0;

  let title = j.title ?? null;
  let author = j.author ?? null;

  if (!author) {
    const a = detectAuthorFromText(userText);
    if (a) author = a;
  }

  if (isBadQuery(query)) {
    query = buildFallbackQueryFromUserText(userText);
    confidence = Math.max(confidence, 0.55);
  } else if (query && confidence === 0) {
    confidence = 0.55;
  }

  return {
    query,
    title,
    author,
    confidence,
    query_ru: j.query_ru ?? null,
    title_ru: j.title_ru ?? null,
    author_ru: j.author_ru ?? null,
    keywords: [],
    tags: [],
  };
}