import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonLoose } from "../src/llm/jsonExtract.js";

// Response styles seen from models other than Gemini-with-responseSchema.

test("plain JSON", () => {
  assert.deepEqual(parseJsonLoose('{"title":"Мы","author":null}'), { title: "Мы", author: null });
});

test("```json fenced", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"title":"Мы"}\n```'), { title: "Мы" });
});

test("fenced block with text before and after", () => {
  const text = 'Here is the result:\n```json\n{"title":"Мы","confidence":0.9}\n```\nLet me know if {anything} else.';
  assert.deepEqual(parseJsonLoose(text), { title: "Мы", confidence: 0.9 });
});

test("bare object with text before and after", () => {
  assert.deepEqual(parseJsonLoose('Sure! {"title":"Мы"} Hope this helps.'), { title: "Мы" });
});

test("<think> block before the answer is ignored", () => {
  const text = '<think>The cover says {Мы}, maybe Zamyatin...</think>\n{"title":"Мы","author":"Евгений Замятин"}';
  assert.deepEqual(parseJsonLoose(text), { title: "Мы", author: "Евгений Замятин" });
});

test("unclosed <think> (budget ran out mid-thought) -> throws", () => {
  assert.throws(() => parseJsonLoose('<think>Let me look at {"title": the cover'), /No JSON object found/);
});

test("empty and whitespace-only -> throws", () => {
  assert.throws(() => parseJsonLoose(""), /No JSON object found/);
  assert.throws(() => parseJsonLoose("   \n"), /No JSON object found/);
  assert.throws(() => parseJsonLoose(null), /No JSON object found/);
});

test("prose without JSON -> throws", () => {
  assert.throws(() => parseJsonLoose("I could not identify this book."), /No JSON object found/);
});

test("top-level array parses as-is", () => {
  assert.deepEqual(parseJsonLoose('[{"title":"Мы"}]'), [{ title: "Мы" }]);
});

// --- truncated output (small max-token budgets) ---

test("truncated inside a string value -> value kept up to the cut", () => {
  assert.deepEqual(parseJsonLoose('{"title":"Мастер и Марг'), { title: "Мастер и Марг" });
});

test("truncated right after a comma", () => {
  assert.deepEqual(parseJsonLoose('{"title":"Мы",'), { title: "Мы" });
});

test("truncated inside a key / right after a key -> dangling key dropped", () => {
  assert.deepEqual(parseJsonLoose('{"title":"Мы","auth'), { title: "Мы" });
  assert.deepEqual(parseJsonLoose('{"title":"Мы","author"'), { title: "Мы" });
  assert.deepEqual(parseJsonLoose('{"title":"Мы","author":'), { title: "Мы" });
  assert.deepEqual(parseJsonLoose('{"title":"Мы","author": '), { title: "Мы" });
});

test("truncated inside a literal or a number", () => {
  assert.deepEqual(parseJsonLoose('{"title":"Мы","author":nu'), { title: "Мы" });
  assert.deepEqual(parseJsonLoose('{"title":"Мы","confidence":0.'), { title: "Мы", confidence: 0 });
  assert.deepEqual(parseJsonLoose('{"title":"Мы","author":null'), { title: "Мы", author: null });
});

test("truncated inside a nested array of objects", () => {
  const text = '{"items":[{"title":"Мы","confidence":0.9,"evidence":["МЫ","Евг';
  assert.deepEqual(parseJsonLoose(text), { items: [{ title: "Мы", confidence: 0.9, evidence: ["МЫ", "Евг"] }] });
});

test("truncated inside an unclosed ```json fence", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"title":"Мы","author":"Евгений'), { title: "Мы", author: "Евгений" });
});

test("truncated after prose prefix", () => {
  assert.deepEqual(parseJsonLoose('Result: {"title":"Мы","conf'), { title: "Мы" });
});
