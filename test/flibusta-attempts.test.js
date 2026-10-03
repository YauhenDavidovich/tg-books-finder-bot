import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFlibustaAttemptsFromVisionItem, buildFlibustaAttemptsFromQuery } from "../src/core/flibustaAttempts.js";

const has = (attempts, title, author) => attempts.some((a) => a.title === title && a.author === author);

test("vision: a title-only attempt exists even when the author is known", () => {
  // e.g. Qwen returning a confidently wrong author with confidence 0.97
  const attempts = buildFlibustaAttemptsFromVisionItem({ title: "Мы", author: "Михаил Булгаков", variants: [] });
  assert.ok(has(attempts, "Мы", "Михаил Булгаков"));
  assert.ok(has(attempts, "Мы", null));
});

test("vision: RU and EN titles also get title-only attempts", () => {
  const attempts = buildFlibustaAttemptsFromVisionItem({
    title: "We",
    author: "Wrong Author",
    title_ru: "Мы",
    author_ru: "Неверный Автор",
    title_en: "We",
    author_en: "Wrong Author",
    variants: [],
  });
  assert.deepEqual(attempts, [
    { title: "We", author: "Wrong Author" },
    { title: "We", author: null },
    { title: "Мы", author: "Неверный Автор" },
    { title: "Мы", author: null },
  ]);
});

test("vision: bare titles from variants don't duplicate the title-only attempt", () => {
  const attempts = buildFlibustaAttemptsFromVisionItem({ title: "Мы", author: "Евгений Замятин", variants: ["Мы", "мы", "Мы Замятин"] });
  assert.deepEqual(attempts, [
    { title: "Мы", author: "Евгений Замятин" },
    { title: "Мы", author: null },
    { title: "Мы Замятин", author: null },
  ]);
});

test("vision: no author -> single title-only attempt", () => {
  assert.deepEqual(buildFlibustaAttemptsFromVisionItem({ title: "Мы", author: null }), [{ title: "Мы", author: null }]);
});

test("text query: title-only attempt and raw input are kept", () => {
  const attempts = buildFlibustaAttemptsFromQuery({ title: "We", author: "Yevgeny Zamyatin", title_ru: "Мы", author_ru: "Евгений Замятин", query: "антиутопия" }, "Замятин Мы");
  assert.deepEqual(attempts, [
    { title: "Мы", author: "Евгений Замятин" },
    { title: "We", author: "Yevgeny Zamyatin" },
    { title: "We", author: null },
    { title: "антиутопия", author: null },
    { title: "Замятин Мы", author: null },
  ]);
});
