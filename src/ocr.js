import vision from "@google-cloud/vision";

const client = new vision.ImageAnnotatorClient();

export async function extractTextFromImage(buffer, mode = "TEXT") {
  // mode: "TEXT" | "DOCUMENT"
  if (mode === "DOCUMENT") {
    const [result] = await client.documentTextDetection({ image: { content: buffer } });
    const text = result?.fullTextAnnotation?.text || "";
    return { text, raw: result };
  }

  const [result] = await client.textDetection({ image: { content: buffer } });
  const text = result?.fullTextAnnotation?.text || "";
  return { text, raw: result };
}