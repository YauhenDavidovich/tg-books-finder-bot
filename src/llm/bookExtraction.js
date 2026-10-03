// Book identification through the LLM client (FreeLLMAPI, falling back to
// direct Gemini):
//   T1  text description -> search query
//   V1  cover photo -> title/author
//   V2  V1 result -> RU/EN titles and search variants
// User prompts and Gemini schemas are the pre-router ones, unchanged, so the
// direct Gemini path sends exactly what it did before. The router path adds
// a system prompt spelling out the JSON shape and rules, since most free
// models don't enforce a schema natively, and every answer is validated
// with zod.
import { z } from "zod";
import { config } from "../config.js";
import { getDefaultLlm } from "./client.js";
import { describeShape, toJsonSchema } from "./geminiSchema.js";

// ---------- shared zod pieces (lenient where models differ in style) ----------

// Missing/empty -> null. Models also spell "no value" as text, or return
// a list of authors.
const nullableText = z.preprocess((v) => {
  if (Array.isArray(v)) v = v.filter((x) => typeof x === "string").join(", ");
  if (typeof v === "number") v = String(v);
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return v;
  const s = v.trim();
  return s && !/^(null|none|unknown|n\/a|-)$/i.test(s) ? s : null;
}, z.string().nullable());

// 0..1. Accepts "0.9" and percentages (97 -> 0.97); missing -> 0, as the
// pre-router parsing did.
const confidence = z.preprocess((v) => {
  if (v === undefined || v === null) return 0;
  const n = typeof v === "string" ? Number(v.replace("%", "").replace(",", ".").trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return v;
  return n > 1 && n <= 100 ? n / 100 : n;
}, z.number().min(0).max(1));

const stringList = z.preprocess((v) => {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") v = [v];
  return Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) : v;
}, z.array(z.string()));

function llmStep(step, r) {
  return {
    step,
    via: r.via,
    model: r.model,
    latencyMs: r.latencyMs,
    finishReason: r.finishReason,
    attempts: r.attempts,
    text: r.text,
  };
}

// ---------- T1: text description -> search query ----------

function buildTextPrompt(userText) {
  return (
    "You extract book search data from a user's description.\n\n" +
    "Field rules:\n" +
    "- query: 2–6 words, must be useful for searching a book, include key nouns, no filler words like book/story/novel.\n" +
    "- title: exact title ONLY if you are very sure, otherwise null. Use whatever language you are most confident is the exact title (do not translate unnecessarily).\n" +
    "- author: exact author ONLY if you are very sure, otherwise null.\n" +
    "- title_ru: the Russian title of the same work, if you know one (translated or original). If title is already Russian, repeat it here. Otherwise null.\n" +
    '- author_ru: the author\'s name in Russian/Cyrillic spelling, if you know it (e.g. "Стивен Кинг" for "Stephen King"). Otherwise null.\n' +
    "- confidence: 0.9–1.0 famous clearly identified, 0.6–0.8 strong guess, 0.3–0.5 weak guess, 0.0–0.2 almost no idea.\n\n" +
    "Important behavior:\n" +
    "- NEVER invent a fake title or author.\n" +
    "- If unsure, still produce the best possible query.\n\n" +
    "User description:\n" +
    "```text\n" +
    String(userText || "") +
    "\n```"
  );
}

// Enforced natively via generationConfig.responseSchema on the Gemini path -
// Gemini's API then guarantees every field is present with the right type,
// instead of only being told via prompt text to include them (which it
// wasn't reliably doing: title_ru/author_ru were silently omitted in
// practice despite the prompt explicitly saying "NEVER omit fields").
const TEXT_GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    query: { type: "STRING" },
    title: { type: "STRING", nullable: true },
    author: { type: "STRING", nullable: true },
    title_ru: { type: "STRING", nullable: true },
    author_ru: { type: "STRING", nullable: true },
    confidence: { type: "NUMBER" },
  },
  required: ["query", "title", "author", "title_ru", "author_ru", "confidence"],
};

const TEXT_SYSTEM = [
  "You identify books from a user's description, to search a Russian-language e-library (Flibusta).",
  `Return one JSON object with exactly this shape: ${describeShape(TEXT_GEMINI_SCHEMA)}`,
  "- title/author: the exact title and name as you know them, in their original language - do not translate them. Russian forms go only into title_ru/author_ru.",
  "- Never invent a book, title or author. If you are not sure, use null and a low confidence (0.3 or less) - the search still works from query.",
].join("\n");

export const BookQuerySchema = z.object({
  query: z.string().transform((s) => s.trim()),
  title: nullableText,
  author: nullableText,
  title_ru: nullableText,
  author_ru: nullableText,
  confidence,
});

/** → { query: { query, title, author, title_ru, author_ru, confidence }, llm: [step] } */
export async function extractBookQueryFromText(userText, { llm = getDefaultLlm() } = {}) {
  const r = await llm.chatJson(buildTextPrompt(userText), {
    system: TEXT_SYSTEM,
    schema: BookQuerySchema,
    jsonSchema: toJsonSchema(TEXT_GEMINI_SCHEMA),
    schemaName: "book_query",
    maxTokens: 2048,
    geminiSchema: TEXT_GEMINI_SCHEMA,
    geminiMaxTokens: 1024,
  });
  return { query: r.data, llm: [llmStep("text", r)] };
}

// ---------- V1: cover photo -> title/author ----------

// --- STEP 1: минимум, чтобы почти не обрезало
const COVER_PROMPT =
  "Extract book title/author from the image.\n" +
  "Rules:\n" +
  "- Do not invent. If unsure, return an empty items array.\n" +
  "- evidence must be exact text seen on the image.\n" +
  "- Ignore UI elements and stickers.\n";

const COVER_GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          author: { type: "STRING", nullable: true },
          isbn: { type: "STRING", nullable: true },
          confidence: { type: "NUMBER" },
          evidence: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["title", "author", "isbn", "confidence", "evidence"],
      },
    },
  },
  required: ["items"],
};

const COVER_SYSTEM = [
  "You read book titles and authors from photos of book covers and screenshots.",
  `Return one JSON object with exactly this shape: ${describeShape(COVER_GEMINI_SCHEMA)}`,
  "- Copy title and author exactly as printed, in the original language and script. Do not translate or correct them.",
  "- author: only a name you can actually read on the image. If none is visible, use null - never fill it in from memory.",
  "- confidence (0-1): how sure you are that the title is read correctly. Lower it instead of guessing.",
  '- If no book title is readable, return {"items": []}.',
].join("\n");

const CoverItemSchema = z.object({
  title: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string()),
  author: nullableText,
  isbn: nullableText,
  confidence,
  evidence: stringList,
});

export const CoverExtractSchema = z.preprocess((v) => {
  // Accept a bare item or a bare array instead of {items: [...]}, and drop
  // the empty objects a repaired truncated response can leave behind.
  if (Array.isArray(v)) v = { items: v };
  else if (v && typeof v === "object" && !("items" in v) && "title" in v) v = { items: [v] };
  if (v && Array.isArray(v.items)) {
    v = { ...v, items: v.items.filter((it) => !(it && typeof it === "object" && Object.keys(it).length === 0)) };
  }
  return v;
}, z.object({ items: z.array(CoverItemSchema) }));

// ---------- V2: enrich (EN/RU/variants) ----------

const ENRICH_GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    title_en: { type: "STRING", nullable: true },
    author_en: { type: "STRING", nullable: true },
    title_ru: { type: "STRING", nullable: true },
    author_ru: { type: "STRING", nullable: true },
    variants: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["title_en", "author_en", "title_ru", "author_ru", "variants"],
};

function buildEnrichPrompt(baseItem) {
  return (
    "Enrich extracted book info.\n" +
    "Rules:\n" +
    "- Do not invent if unknown.\n" +
    "- If the cover is EN, try to provide well-known RU translation.\n" +
    "- variants: 6-10 short strings for Flibusta, each <= 80 chars, mix EN/RU.\n" +
    "Base:\n" +
    JSON.stringify({ title: baseItem.title, author: baseItem.author, isbn: baseItem.isbn }) +
    "\nEvidence:\n" +
    (baseItem.evidence || []).join(" | ")
  );
}

const ENRICH_SYSTEM = [
  "You enrich book metadata so the book can be found in a Russian-language e-library (Flibusta). You get the title/author read from a cover; you do not see the image.",
  `Return one JSON object with exactly this shape: ${describeShape(ENRICH_GEMINI_SCHEMA)}`,
  "- title_en/author_en, title_ru/author_ru: only real published titles and the standard spelling of the author's name. Use null if you don't know one - do not invent titles.",
  "- variants: short search strings mixing the original, EN and RU forms of the title, with and without the author.",
].join("\n");

export const EnrichSchema = z.object({
  title_en: nullableText,
  author_en: nullableText,
  title_ru: nullableText,
  author_ru: nullableText,
  variants: stringList,
});

function uniqStrings(arr) {
  return [...new Set((arr || []).map((s) => String(s || "").trim()).filter(Boolean))];
}

/** → { items: [item with title_en/ru, author_en/ru, variants] | [], llm: [steps] } */
export async function extractBookFromImage(imageBuffer, mimeType = "image/jpeg", { llm = getDefaultLlm() } = {}) {
  const b64 = imageBuffer.toString("base64");
  // Router-only (FreeLLMAPI maps it to Gemini's thinkingBudget): reading a
  // cover doesn't need thinking, and it's most of the vision latency.
  const reasoningEffort = config.LLM_COVER_REASONING_EFFORT || undefined;
  const steps = [];

  const r1 = await llm.visionJson(b64, mimeType, COVER_PROMPT, {
    system: COVER_SYSTEM,
    schema: CoverExtractSchema,
    jsonSchema: toJsonSchema(COVER_GEMINI_SCHEMA),
    schemaName: "cover_extract",
    maxTokens: 1024,
    reasoningEffort,
    geminiSchema: COVER_GEMINI_SCHEMA,
    geminiMaxTokens: 320,
  });
  steps.push(llmStep("cover", r1));

  const items = r1.data.items;

  // если пусто, сразу вернём как есть, но в расширенном формате
  if (!items.length) {
    return { items: [], llm: steps };
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
        variants: uniqStrings([baseItem.author ? `${baseItem.title} ${baseItem.author}` : null, baseItem.title]),
      },
    ],
  };

  // --- STEP 2: enrich (EN/RU/variants). Если упадёт, вернём baseResult.
  // On the router this is a text-only call fed with step 1's title/author:
  // a second vision call doubled the wait (~16s each on Gemini 3.5 Flash).
  // The direct Gemini path still sends the image, as before (directImage).
  let enrich = {};
  try {
    const r2 = await llm.chatJson(buildEnrichPrompt(baseItem), {
      system: ENRICH_SYSTEM,
      schema: EnrichSchema,
      jsonSchema: toJsonSchema(ENRICH_GEMINI_SCHEMA),
      schemaName: "cover_enrich",
      maxTokens: 1024,
      reasoningEffort,
      geminiSchema: ENRICH_GEMINI_SCHEMA,
      geminiMaxTokens: 260,
      directImage: { base64: b64, mimeType },
    });
    steps.push(llmStep("enrich", r2));
    enrich = r2.data;
  } catch (err) {
    steps.push({ step: "enrich", error: String(err?.message || err).split("\n")[0], attempts: err?.attempts || [] });
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

  return { items: [merged], llm: steps };
}
