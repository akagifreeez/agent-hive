import { test } from "node:test";
import { runCommand } from "./src/engine/exec.js";
import { setSemaphoreSelfBlockGuard, resetTestSemaphore, setTestMaxConcurrent, testSemaphoreState, runTestCommand, runCommandInner } from "./src/engine/test-semaphore.js";
import assert from "node:assert/strict";
test("probe2: guard off + waiting loop なし", async () => {
  setSemaphoreSelfBlockGuard(true);
  resetTestSemaphore(); setTestMaxConcurrent(1);
  setSemaphoreSelfBlockGuard(false);
  try {
    // 待ちループ無し: 即座に2本目を投げる(slowのスロット獲得と競う)
    const hold = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000 });
    await new Promise((r) => setTimeout(r, 20)); // ほんの少し
    const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300 }, runCommandInner);
    console.log("P2 waiter.ok=", waiter.ok, "running=", testSemaphoreState().running);
    assert.equal(waiter.ok, false, "タイムアウト失敗のはず");
    await hold;
  } finally { resetTestSemaphore(); setSemaphoreSelfBlockGuard(true); }
});
