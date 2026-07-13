import { test } from "node:test";
import assert from "node:assert/strict";
import { norm, scoreMatch, shortTitle } from "../src/core/matching.js";

// Note: the token-overlap bonus is a separate `if` block from the
// exact/partial-match check, not an `else if` - so an exact or substring
// title match also picks up the token-overlap bonus on top (ratio is always
// 1.0 when ct === qt or one contains the other with matching tokens).
// Expected values below were verified against the actual function, not
// hand-computed, to avoid exactly this kind of off-by-N mistake.

test("exact title match, no author -> 6 (exact) + 2 (token overlap) = 8", () => {
  const score = scoreMatch({ title: "Война и мир" }, "Война и мир", "");
  assert.equal(score, 8);
});

test("exact title + exact author -> 8 (title) + 4 (author) = 12", () => {
  const score = scoreMatch({ title: "Идиот", author: "Достоевский" }, "Идиот", "Достоевский");
  assert.equal(score, 12);
});

test("punctuation/case are ignored by norm() - same score as a clean exact match", () => {
  assert.equal(norm("ВОЙНА, И МИР!!!"), norm("война и мир"));
  const score = scoreMatch({ title: "ВОЙНА, И МИР!!!" }, "война и мир", "");
  assert.equal(score, 8);
});

test("ё/е normalization treats them as identical", () => {
  assert.equal(norm("Ёлка"), norm("елка"));
});

test("substring match (partial) also picks up the token-overlap bonus: 4 + 2 = 6", () => {
  const score = scoreMatch({ title: "Преступление и наказание" }, "наказание", "");
  assert.equal(score, 6);
});

test("token overlap >= 0.8 without an exact/substring match scores only +2", () => {
  // candidate title reordered relative to the query -> not a substring match
  // in either direction, but all 4 query tokens are present -> ratio 1.0.
  const candidate = { title: "пути перевал в середине" };
  const score = scoreMatch(candidate, "перевал в середине пути", "");
  assert.equal(score, 2);
});

test("token overlap in the 0.6-0.8 band scores only +1", () => {
  // query has 3 tokens, candidate title contains 2 of them (ratio 0.66).
  const candidate = { title: "средние века герой" };
  const score = scoreMatch(candidate, "средние века дракон", "");
  assert.equal(score, 1);
});

test("no cross-script (Latin <-> Cyrillic) matching", () => {
  const score = scoreMatch({ title: "Преступление и наказание" }, "Crime and Punishment", "");
  assert.equal(score, 0);
});

test("author partial match scores +2 (substring, not exact; no token-overlap bonus for author)", () => {
  const score = scoreMatch({ author: "Фёдор Михайлович Достоевский" }, "", "достоевский");
  assert.equal(score, 2);
});

test("missing candidate title/author still scores 6, not 0 - '' is a substring of everything", () => {
  // Documents a real quirk: ct.includes(qt) || qt.includes(ct) is true
  // whenever ct === "" (candidate has no title), because an empty string is
  // a substring of any string in JS. Same for author. A Flibusta result with
  // no title/author data can therefore clear tryFlibustaFirst's minScore (4)
  // threshold purely from this artifact.
  assert.doesNotThrow(() => scoreMatch({ title: undefined, author: null }, "x", "y"));
  const score = scoreMatch({ title: undefined, author: null }, "x", "y");
  assert.equal(score, 6);
});

test("shortTitle cuts at a delimiter when the result is long enough", () => {
  assert.equal(shortTitle("Война и мир: Том 1"), "Война и мир");
});

test("shortTitle falls back to the original when the cut is too short", () => {
  assert.equal(shortTitle(": abc"), ": abc");
});
