// blocker waiting-loop が100回(1秒)で抜けた場合の検証: running<1のまま抜けたら印を出す
import { runCommand } from "./src/engine/exec.js";
import { runTestCommand, resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState } from "./src/engine/test-semaphore.js";
import { test } from "node:test";
async function withSem(max, fn) {
  resetTestSemaphore(); if (max) setTestMaxConcurrent(max);
  try { await fn(); } finally { resetTestSemaphore(); setSemaphoreSelfBlockGuard(false); }
}
test("probe blocker-late", async () => {
  await withSem(1, async () => {
    setSemaphoreSelfBlockGuard(true);
    const blocker = runTestCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000, forceWait: true }, (o) => runCommand(o));
    let hits = 0;
    for (let i = 0; i < 3000 && testSemaphoreState().running < 1; i++) { await new Promise(r => setTimeout(r, 10)); hits++; }
    console.error("BLOCKER wait iterations:", hits, "final running:", JSON.stringify(testSemaphoreState()));
    const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300, forceWait: true }, (o) => runCommand(o));
    console.error("waiter ok:", waiter.ok);
    await blocker;
  });
});
