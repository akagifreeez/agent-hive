import { test } from "node:test";
import assert from "node:assert/strict";
import { padCenter } from "../src/pad.js";

test("padCenter: 中央寄せ(偶数余り)", () => {
  assert.equal(padCenter("ab", 6), "  ab  ");
});

test("padCenter: 長さ超過ならそのまま", () => {
  assert.equal(padCenter("abcdef", 3), "abcdef");
});

test("padCenter: 奇数余りは左側が少ない", () => {
  assert.equal(padCenter("a", 4), " a  ");
});
