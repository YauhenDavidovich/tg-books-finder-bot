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
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("No JSON object found in Gemini response");
  }
  return s.slice(first, last + 1);
}

function readCandidateText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";

  // Gemini иногда возвращает несколько parts
  // Соберём все .text в одну строку
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function geminiExtractBookFromImageBuffer(imageBuffer, mimeType = "image/jpeg") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  const b64 = imageBuffer.toString("base64");

  const prompt = `
You are a book identifier.
Extract book title and author from the image.
Return ONLY JSON:
{"items":[{"title":string,"author":string|null,"title_en":string|null,"author_en":string|null,"isbn":string|null,"confidence":number,"evidence":string[]}]}

Rules:
- Do not invent.
- Evidence must be exact text you can read on the image (title/author fragments).
- Ignore UI elements like likes, comments, usernames, time, follow.
`.trim();

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
      generationConfig: { temperature: 0, maxOutputTokens: 512 },
    }),
  });

  const rawBody = await res.text();
  if (!res.ok) throw new Error(`Gemini error: ${res.status} ${rawBody}`);

  const data = JSON.parse(rawBody);

  // 1) основной путь: собрать текст из parts
  let text = readCandidateText(data);

  // 2) если вдруг пусто, попробуем старое поле (на всякий)
  if (!text) text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  // 3) чистим markdown
  const cleaned = stripCodeFences(text);

  // 4) пытаемся распарсить как есть, иначе вырезаем JSON объект
  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonOnly = extractJsonObject(cleaned);
    return JSON.parse(jsonOnly);
  }
}