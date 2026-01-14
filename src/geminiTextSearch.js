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

export async function geminiExtractBookQueryFromText(userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  const prompt =
    "You help search for books by a user's description.\n" +
    "Return ONLY minified JSON. No markdown.\n" +
    '{"query":string,"title":string|null,"author":string|null,"keywords":string[],"tags":string[],"confidence":number}\n' +
    "Rules:\n" +
    "- Do not invent exact title/author if not sure. Use null.\n" +
    "- query must be short and useful for Google Books search.\n" +
    "- keywords 5-10 items, tags 5-8 items.\n" +
    "- If too little info, return confidence < 0.5.\n" +
    "Input:\n" +
    userText;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 512 },
    }),
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`Gemini error: ${res.status} ${raw}`);

  const data = JSON.parse(raw);
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p?.text).filter(Boolean).join("\n") || "";

  const cleaned = stripCodeFences(text);

  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonOnly = extractJsonObject(cleaned);
    if (!jsonOnly) throw new Error(`No JSON in Gemini text-search response. Preview:\n${cleaned.slice(0, 800)}`);
    return JSON.parse(jsonOnly);
  }
}