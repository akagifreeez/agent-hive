import { test } from "node:test";
import assert from "node:assert/strict";
import { toUpperSnake } from "../src/upper.js";

test("toUpperSnake: 空文字は空文字", () => {
  assert.equal(toUpperSnake(""), "");
});

test("toUpperSnake: スペース区切りは_で繋ぐ", () => {
  assert.equal(toUpperSnake("hello world"), "HELLO_WORLD");
});

test("toUpperSnake: ハイフンとキャメルも分割する", () => {
  assert.equal(toUpperSnake("foo-barBaz"), "FOO_BAR_BAZ");
});

test("toUpperSnake: 連続区切りは潰す", () => {
  assert.equal(toUpperSnake("a--b  c"), "A_B_C");
});
