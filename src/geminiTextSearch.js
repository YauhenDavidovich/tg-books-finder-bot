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

export async function geminiExtractBookQueryFromText(userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  const prompt =
    "Return ONLY minified JSON. No markdown, no extra text.\n" +
    'Schema: {"query":string,"title":string|null,"author":string|null,"confidence":number,' +
    '"query_ru":string|null,"title_ru":string|null,"author_ru":string|null,' +
    '"keywords":string[],"tags":string[],"variants":string[]}\n' +
    "Rules: do not invent. query short. keywords 4-7. tags 4-7. variants 6-10 (<=80 chars).\n" +
    "Input:\n" +
    userText;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const reqBody = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 512,
      responseMimeType: "application/json",
    },
    // ключевой фикс: режем размышления, чтобы не упираться в MAX_TOKENS раньше времени
    thinkingConfig: { thinkingBudget: 0 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
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

  // 4) нормальная ошибка
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

  throw new Error(`No JSON in Gemini text-search response. Preview:\n${preview}\n\nMeta:\n${meta}`);
}