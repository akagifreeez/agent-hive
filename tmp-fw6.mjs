// 連続ファイル実行の2周目相当: T2→T3が走った直後、T4のblocker発射がいつ遅れるか
// (T3で「npm test -- dummy-slow」のspawnが残り、T4開始時に親のnode:testコンテキストが忙しい)
import { runCommand } from "./src/engine/exec.js";
import { runTestCommand, resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState } from "./src/engine/test-semaphore.js";
import { test } from "node:test";
async function withSem(max, fn) {
  resetTestSemaphore(); if (max) setTestMaxConcurrent(max);
  try { await fn(); } finally { resetTestSemaphore(); setSemaphoreSelfBlockGuard(false); }
}
test("probe T2 serial", async () => {
  await withSem(1, async () => {
    const cmd = "node --test test/fixtures/empty.test.js";
    const p1 = runCommand({ command: cmd + " && echo d1", timeoutMs: 15000 });
    await new Promise(r => setTimeout(r, 60));
    const p2 = runCommand({ command: cmd + " && echo d2", timeoutMs: 15000 });
    await p1; await p2;
  });
});
test("probe T3 other-pass", async () => {
  await withSem(1, async () => {
    const slow = runCommand({ command: "npm test -- dummy-slow", timeoutMs: 15000 });
    await new Promise(r => setTimeout(r, 60));
    const other = await runCommand({ command: "echo non-test-command", timeoutMs: 15000 });
    await slow;
  });
});
test("probe T4 forceWait", async () => {
  await withSem(1, async () => {
    setSemaphoreSelfBlockGuard(true);
    const blocker = runTestCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000, forceWait: true }, (o) => runCommand(o));
    let iters = 0;
    for (let i = 0; i < 3000 && testSemaphoreState().running < 1; i++) { await new Promise(r => setTimeout(r, 10)); iters++; }
    console.error("T4 blocker iterations:", iters, "state:", JSON.stringify(testSemaphoreState()));
    const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300, forceWait: true }, (o) => runCommand(o));
    console.error("T4 waiter ok:", waiter.ok);
    await blocker;
  });
});
