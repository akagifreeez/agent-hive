// テストセマフォのスロットリーク回帰(2026-10-08朝の実障害):
// drain()と起床側の二重加算で、待ち行列を通った呼出のぶんだけ running が永久リークし、
// 「実行中(なし)なのに全bashが600秒タイムアウト」になった。待ち行列を通っても
// スロットが確実に解放されることをここで固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTestCommand, resetTestSemaphore, testSemaphoreState, isTestCommand } from "../src/engine/test-semaphore.js";

test("semaphore-leak: 待ち行列を通った呼出でもスロットが解放される", async () => {
  resetTestSemaphore();
  let release1;
  const gate1 = new Promise((res) => { release1 = res; });
  const r1 = runTestCommand({ command: "npm test run1" }, async () => { await gate1; return { ok: true, text: "1" }; });
  await new Promise((r) => setTimeout(r, 10)); // 1つ目がスロットを掴むまで待つ
  const r2 = runTestCommand({ command: "npm test run2" }, async () => ({ ok: true, text: "2" }));
  const r3 = runTestCommand({ command: "npm test run3" }, async () => ({ ok: true, text: "3" }));
  assert.ok(testSemaphoreState().queued >= 1, "2つ目以降はキューで待つ");
  release1();
  const [a, b, c] = await Promise.all([r1, r2, r3]);
  assert.deepEqual([a.text, b.text, c.text], ["1", "2", "3"]);
  const st = testSemaphoreState();
  assert.equal(st.running, 0, `待ち行列を通った分が解放されていない(running=${st.running}=リーク)`);
  assert.equal(st.queued, 0);
  resetTestSemaphore();
});

test("semaphore-leak: isTestCommandはテスト系コマンドだけにマッチする", () => {
  assert.equal(isTestCommand("npm test"), true);
  assert.equal(isTestCommand("cd foo && npm test"), true);
  assert.equal(isTestCommand("node --test tests/"), true);
  assert.equal(isTestCommand("git worktree add wt main"), false, "gitコマンドは対象外");
  assert.equal(isTestCommand("cat package.json"), false, "catは対象外");
  assert.equal(isTestCommand("echo npm test"), false, "文中のtest語には反応しない");
});
