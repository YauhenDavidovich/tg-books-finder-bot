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
      // снимаем если совпало
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
    }
  }

  let repaired = str;

  // если обрезало внутри строки, закроем кавычку
  if (inString) repaired += '"';

  // уберём хвост, если заканчивается на очевидный мусор типа "...,"
  repaired = repaired.replace(/,\s*$/, "");

  // закроем незакрытые массивы/объекты
  while (stack.length) repaired += stack.pop();

  // финальная страховка: если всё равно нет закрывающей }
  if (!repaired.endsWith("}")) repaired += "}";

  return repaired;
}

export async function geminiExtractBookQueryFromText(userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  // меньше полей = меньше шанс обрезания
  const prompt =
    "You help search for books by a user's description.\n" +
    "Return ONLY minified JSON. No markdown, no extra text.\n" +
    '{"query":string,"title":string|null,"author":string|null,"keywords":string[],"tags":string[],"confidence":number,' +
    '"query_ru":string|null,"title_ru":string|null,"author_ru":string|null,"variants":string[]}\n' +
    "Rules:\n" +
    "- Do not invent exact title/author if not sure. Use null.\n" +
    "- query must be short and useful for Google Books search.\n" +
    "- keywords: 4-7 items, tags: 4-7 items.\n" +
    "- variants: 6-10 items, each <= 80 chars.\n" +
    "- If too little info, return confidence < 0.5.\n" +
    "Input:\n" +
    userText;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 384, // меньше, чтобы модель не разгонялась
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
    return JSON.parse(cleaned);
  } catch {}

  // 2) вырезать объект, если есть закрывающая }
  const jsonOnly = extractJsonObject(cleaned);
  if (jsonOnly) {
    try {
      return JSON.parse(jsonOnly);
    } catch {}
  }

  // 3) попытка починить обрезанный JSON
  const repaired = tryRepairTruncatedJson(cleaned);
  if (repaired) {
    try {
      return JSON.parse(repaired);
    } catch {}
  }

  // 4) нормальная ошибка с подсказкой
  const preview = cleaned.slice(0, 900);
  const meta = JSON.stringify(
    {
      finishReason,
      candidateTextPreview: candidateText.slice(0, 1200),
      rawBodyPreview: raw.slice(0, 1200),
    },
    null,
    2
  );

  throw new Error(
    `No JSON in Gemini text-search response. Preview:\n${preview}\n\nMeta:\n${meta}`
  );
}