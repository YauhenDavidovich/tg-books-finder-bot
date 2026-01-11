import fetch from "node-fetch";

export async function geminiExtractBookFromImageBuffer(imageBuffer, mimeType = "image/jpeg") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  const b64 = imageBuffer.toString("base64");

  const prompt = `
You are a book identifier.
Extract book title and author from the image.
Return ONLY JSON:
{"items":[{"title":string,"author":string|null,"confidence":number,"evidence":string[]}]}

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
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: b64 } }
        ]
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 512 }
    })
  });

  if (!res.ok) throw new Error(`Gemini error: ${res.status} ${await res.text()}`);

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return JSON.parse(text);
}