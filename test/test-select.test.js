// 差分→テスト一覧の対応付け(検証テスト選定)の純関数テスト。
// feat-verify-test-select: verify時に回すテストを「差分に関連するテスト+スモーク」へ絞る。
// 純関数(ファイルパス配列→テストファイルパス配列)のみを検証する(I/Oなし・依存ゼロ)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTestsForDiff } from "../src/engine/test-select.js";

test("selectTestsForDiff: src対応ルール(src/engine/exec.js → test/exec-*.test.js相当のglob)", () => {
  const tests = selectTestsForDiff(["src/engine/exec.js"]);
  assert.deepEqual(tests, ["test/exec*.test.js"], "ファイル名base+glob式を返す");
  // 実一覧(allTestFiles)を渡すと実在テストへ展開する(exec-プレフィックスの仲間も拾う)
  const expanded = selectTestsForDiff(["src/engine/exec.js"], {
    allTestFiles: ["test/exec.test.js", "test/exec-semaphore.test.js", "test/executor-timeout.test.js", "test/boardstore.test.js"],
  });
  assert.deepEqual(expanded, ["test/exec-semaphore.test.js", "test/exec.test.js", "test/executor-timeout.test.js"]);
  // 対応元のソースファイル自体は含まない
  assert.ok(!expanded.includes("src/engine/exec.js"));
});

test("selectTestsForDiff: 差分に直接含まれるtest/*.test.jsはそのまま返す", () => {
  const tests = selectTestsForDiff(["test/boardstore.test.js", "src/engine/boardstore.js"]);
  assert.ok(tests.includes("test/boardstore.test.js"), "差分のテストファイルはそのまま");
});

test("selectTestsForDiff: src/engine/x.js → test/x*.test.js の中身対応(xで始まる別名テストも拾う)", () => {
  const tests = selectTestsForDiff(["src/engine/tasks.js"]);
  assert.ok(tests.includes("test/tasks.test.js") || tests.some((t) => /^test\/tasks/.test(t)), "tasks対応テストあり");
});

test("selectTestsForDiff: 対応テストが無い差分は空配列(=スモークのみの合図)", () => {
  const tests = selectTestsForDiff(["README.md"]);
  assert.deepEqual(tests, [], "対応なしは空配列");
});

test("selectTestsForDiff: 重複排除・安定ソート", () => {
  const tests = selectTestsForDiff([
    "test/boardstore.test.js",
    "src/engine/boardstore.js",
    "test/boardstore.test.js",
    "src/engine/boardstore.js",
  ]);
  assert.equal(tests.filter((t) => t === "test/boardstore.test.js").length, 1, "重複排除");
  const sorted = [...tests].sort();
  assert.deepEqual(tests, sorted, "ソート済み(安定)");
});

test("selectTestsForDiff: 空入力は空配列・ディレクトリ風/非対象拡張子も安全", () => {
  assert.deepEqual(selectTestsForDiff([]), []);
  const tests = selectTestsForDiff(["src/engine/unknown-module-xyz.js", "docs/notes.txt"]);
  assert.deepEqual(tests, [], "対応規則に当たらないものは拾わない");
});
