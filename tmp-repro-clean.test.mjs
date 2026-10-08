// 最小再現(整理版): 実テストと完全同一の本体+実import経路
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand, runCommandInner } from "./src/engine/exec.js";
import { setSemaphoreSelfBlockGuard, resetTestSemaphore, setTestMaxConcurrent, testSemaphoreState, runTestCommand } from "./src/engine/test-semaphore.js";
async function withSemaphore(max, fn) {
  resetTestSemaphore();
  if (max !== null && max !== undefined) setTestMaxConcurrent(max);
  try { await fn(); }
  finally { resetTestSemaphore(); setSemaphoreSelfBlockGuard(false); }
}
test("REPRO: 待ちタイムアウトで失敗してもスロットはリークしない", async () => {
  await withSemaphore(1, async () => {
    setSemaphoreSelfBlockGuard(false);
    try {
      const hold = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000 });
      for (let i = 0; i < 100 && testSemaphoreState().running < 1; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300 }, runCommandInner);
      console.log("REPRO waiter.ok=", waiter.ok);
      assert.equal(waiter.ok, false, "待ちタイムアウトで失敗するはず");
      assert.match(waiter.text, /同時実行制限で待機タイムアウト/);
      await hold;
      const next = await runCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000 });
      assert.equal(next.ok, true, `スロットがリーク: ${next.text}`);
    } finally {
      setSemaphoreSelfBlockGuard(true);
    }
  });
});
