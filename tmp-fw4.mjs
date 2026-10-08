// 実況再現: T3(ガードoff区間なし)→T4へ直行する並びで、T3のrunCommandがrunning=0で帰った後に…
import { runCommand } from "./src/engine/exec.js";
import { runTestCommand, resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState } from "./src/engine/test-semaphore.js";
import { test } from "node:test";
async function withSem(max, fn) {
  resetTestSemaphore(); if (max) setTestMaxConcurrent(max);
  try { await fn(); } finally { resetTestSemaphore(); setSemaphoreSelfBlockGuard(false); }
}
test("probe T3", async () => {
  await withSem(1, async () => {
    const slow = runCommand({ command: "npm test -- dummy-slow", timeoutMs: 15000 });
    await new Promise(r => setTimeout(r, 60));
    const other = await runCommand({ command: "echo non-test-command", timeoutMs: 15000 });
    console.error("T3 other ok:", other.ok);
    await slow;
    console.error("T3 end state:", JSON.stringify(testSemaphoreState()));
  });
});
test("probe T4 (直後)", async () => {
  await withSem(1, async () => {
    setSemaphoreSelfBlockGuard(true);
    const blocker = runTestCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000, forceWait: true }, (o) => runCommand(o));
    for (let i = 0; i < 100 && testSemaphoreState().running < 1; i++) await new Promise(r => setTimeout(r, 10));
    console.error("T4 state after wait:", JSON.stringify(testSemaphoreState()));
    const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300, forceWait: true }, (o) => runCommand(o));
    console.error("T4 waiter ok:", waiter.ok, String(waiter.text).slice(0, 40).replace(/\n/g, "/"));
    await blocker;
  });
});
