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
  if (!Array.isArray(parts)) return { text: "", partsPreview: [] };

  const partsPreview = parts.map((p) => ({
    hasText: typeof p?.text === "string",
    textPreview: typeof p?.text === "string" ? p.text.slice(0, 400) : null,
    hasInlineData: !!p?.inlineData,
  }));

  const text = parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();

  return { text, partsPreview };
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

function buildGeminiDebug(data, rawBody, candidateText) {
  const cand = data?.candidates?.[0];
  const finishReason = cand?.finishReason || null;
  const safety = cand?.safetyRatings || null;

  return {
    finishReason,
    safetyRatings: safety,
    candidateTextPreview: (candidateText || "").slice(0, 2000),
    rawBodyPreview: (rawBody || "").slice(0, 2000),
    usageMetadata: data?.usageMetadata || null,
  };
}

async function geminiCallJsonImage({ apiKey, prompt, b64, mimeType, maxOutputTokens }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }, { inlineData: { mimeType, data: b64 } }],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens },
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
  const finishReason = cand?.finishReason || null;

  const parts = cand?.content?.parts;
  const { text: candidateText, partsPreview } = readAllParts(parts);

  const cleaned = stripCodeFences(candidateText);

  // 1) прямой JSON.parse
  try {
    return { json: JSON.parse(cleaned), finishReason, rawBody, data, candidateText, partsPreview };
  } catch {}

  // 2) вырезать объект
  const jsonOnly = extractJsonObject(cleaned);
  if (jsonOnly) {
    try {
      return { json: JSON.parse(jsonOnly), finishReason, rawBody, data, candidateText, partsPreview };
    } catch {}
  }

  // 3) попытка починить обрезанный JSON
  const repaired = tryRepairTruncatedJson(cleaned);
  if (repaired) {
    try {
      return { json: JSON.parse(repaired), finishReason, rawBody, data, candidateText, partsPreview };
    } catch {}
  }

  const extra = { partsPreview, ...buildGeminiDebug(data, rawBody, candidateText) };

  throw new Error(
    "No JSON object found in Gemini response.\n" +
      `Candidate text preview:\n${(candidateText || "").slice(0, 800)}\n\n` +
      `Meta:\n${JSON.stringify(extra, null, 2)}`
  );
}

function uniqStrings(arr) {
  return [...new Set((arr || []).map((s) => String(s || "").trim()).filter(Boolean))];
}

export async function geminiExtractBookFromImageBuffer(imageBuffer, mimeType = "image/jpeg") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  const b64 = imageBuffer.toString("base64");

  // --- STEP 1: минимум, чтобы почти не обрезало
  const prompt1 =
    "Extract book title/author from the image.\n" +
    "Return ONLY minified JSON. No markdown.\n" +
    'Schema: {"items":[{"title":string,"author":string|null,"isbn":string|null,"confidence":number,"evidence":string[]}]}\n' +
    "Rules:\n" +
    '- Do not invent. If unsure, return {"items":[]}.\n' +
    "- evidence must be exact text seen on the image.\n" +
    "- Ignore UI elements and stickers.\n";

  const r1 = await geminiCallJsonImage({
    apiKey,
    prompt: prompt1,
    b64,
    mimeType,
    maxOutputTokens: 320,
  });

  const base = r1.json || {};
  const items = Array.isArray(base.items) ? base.items : [];

  // если пусто, сразу вернём как есть, но в расширенном формате
  if (!items.length) {
    return { items: [] };
  }

  // берём лучший
  const best = items
    .slice()
    .sort((a, b) => (Number(b?.confidence ?? 0) || 0) - (Number(a?.confidence ?? 0) || 0))[0];

  const baseItem = {
    title: best?.title ?? "",
    author: best?.author ?? null,
    isbn: best?.isbn ?? null,
    confidence: Number(best?.confidence ?? 0) || 0,
    evidence: Array.isArray(best?.evidence) ? best.evidence.slice(0, 8) : [],
  };

  // базовый ответ всегда отдаём в одном формате
  const baseResult = {
    items: [
      {
        ...baseItem,
        title_en: null,
        author_en: null,
        title_ru: null,
        author_ru: null,
        variants: uniqStrings([
          baseItem.author ? `${baseItem.title} ${baseItem.author}` : null,
          baseItem.title,
        ]),
      },
    ],
  };

  // --- STEP 2: enrich (EN/RU/variants). Если упадёт, вернём baseResult.
  const prompt2 =
    "Enrich extracted book info.\n" +
    "Return ONLY minified JSON. No markdown.\n" +
    'Schema: {"title_en":string|null,"author_en":string|null,"title_ru":string|null,"author_ru":string|null,"variants":string[]}\n' +
    "Rules:\n" +
    "- Do not invent if unknown.\n" +
    "- If the cover is EN, try to provide well-known RU translation.\n" +
    "- variants: 6-10 short strings for Flibusta, each <= 80 chars, mix EN/RU.\n" +
    "Base:\n" +
    JSON.stringify({ title: baseItem.title, author: baseItem.author, isbn: baseItem.isbn }) +
    "\nEvidence:\n" +
    (baseItem.evidence || []).join(" | ");

  let enrich = {};
  try {
    const r2 = await geminiCallJsonImage({
      apiKey,
      prompt: prompt2,
      b64,
      mimeType,
      maxOutputTokens: 260,
    });

    enrich = r2.json || {};
  } catch {
    enrich = {};
  }

  const merged = {
    ...baseResult.items[0],
    title_en: enrich.title_en ?? null,
    author_en: enrich.author_en ?? null,
    title_ru: enrich.title_ru ?? null,
    author_ru: enrich.author_ru ?? null,
  };

  const variants = uniqStrings([
    ...(Array.isArray(enrich.variants) ? enrich.variants : []),
    // страховки
    merged.title && merged.author ? `${merged.title} ${merged.author}` : null,
    merged.title,
    merged.title_ru && merged.author_ru ? `${merged.title_ru} ${merged.author_ru}` : null,
    merged.title_ru,
    merged.title_en && merged.author_en ? `${merged.title_en} ${merged.author_en}` : null,
    merged.title_en,
  ]);

  merged.variants = variants;

  return { items: [merged] };
}