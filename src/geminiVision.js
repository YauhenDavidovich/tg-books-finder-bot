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

function buildGeminiDebug(data, rawBody, candidateText) {
  const cand = data?.candidates?.[0];
  const finishReason = cand?.finishReason || null;
  const safety = cand?.safetyRatings || null;

  return {
    finishReason,
    safetyRatings: safety,
    candidateTextPreview: (candidateText || "").slice(0, 2000),
    rawBodyPreview: (rawBody || "").slice(0, 2000),
  };
}

export async function geminiExtractBookFromImageBuffer(imageBuffer, mimeType = "image/jpeg") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  const b64 = imageBuffer.toString("base64");

  // Короткий prompt, чтобы не упираться в MAX_TOKENS
  const prompt =
    'Extract book title/author from the image. Return ONLY minified JSON. No markdown.\n' +
    '{"items":[{"title":string,"author":string|null,"title_en":string|null,"author_en":string|null,"isbn":string|null,"confidence":number,"evidence":string[]}]}\n' +
    'Rules: do not invent; evidence must be exact text seen on the image; ignore UI; if unsure return {"items":[]}';

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
      generationConfig: { temperature: 0, maxOutputTokens: 1024 },
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
    return JSON.parse(cleaned);
  } catch {}

  // 2) вырезать JSON объект из текста
  const jsonOnly = extractJsonObject(cleaned);
  if (jsonOnly) {
    try {
      return JSON.parse(jsonOnly);
    } catch {}
  }

  // 3) понятная ошибка: если обрезало по токенам, скажем прямо
  const dbg = buildGeminiDebug(data, rawBody, candidateText);
  const extra = { partsPreview, ...dbg };

  if (finishReason === "MAX_TOKENS") {
    throw new Error(
      `Gemini output was truncated (MAX_TOKENS). Increase maxOutputTokens or shorten response.\n` +
        `Candidate text preview:\n${(candidateText || "").slice(0, 800)}\n\n` +
        `Meta:\n${JSON.stringify(extra, null, 2)}`
    );
  }

  throw new Error(
    `No JSON object found in Gemini response.\n` +
      `Candidate text preview:\n${(candidateText || "").slice(0, 800)}\n\n` +
      `Meta:\n${JSON.stringify(extra, null, 2)}`
  );
}