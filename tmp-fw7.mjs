// 失敗時のwaiterテキスト全体を吐く(前回はtrue!== false でok=true=待ちゼロで通過=スロット空き)
// → T2/T3のrunCommand経由の走り残し(スロット保持)との競合を疑い、T3直後に状態を観測する
import { runCommand } from "./src/engine/exec.js";
import { runTestCommand, resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState } from "./src/engine/test-semaphore.js";
import { test } from "node:test";
async function withSem(max, fn) {
  resetTestSemaphore(); if (max) setTestMaxConcurrent(max);
  try { await fn(); } finally { resetTestSemaphore(); setSemaphoreSelfBlockGuard(false); }
}
let t3end = null;
test("isTestCommand probe", () => {});
test("T2 serial probe", async () => {
  await withSem(1, async () => {
    const cmd = "node --test test/fixtures/empty.test.js";
    const p1 = runCommand({ command: cmd + " && echo d1", timeoutMs: 15000 });
    await new Promise(r => setTimeout(r, 60));
    const p2 = runCommand({ command: cmd + " && echo d2", timeoutMs: 15000 });
    await p1; await p2;
  });
});
test("T3 other probe", async () => {
  await withSem(1, async () => {
    const slow = runCommand({ command: "npm test -- dummy-slow", timeoutMs: 15000 });
    await new Promise(r => setTimeout(r, 60));
    await runCommand({ command: "echo non-test-command", timeoutMs: 15000 });
    await slow;
  });
  t3end = Date.now();
});
test("T4 forceWait probe(直後・状態ダンプ)", async () => {
  await withSem(1, async () => {
    setSemaphoreSelfBlockGuard(true);
    const blocker = runTestCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000, forceWait: true }, (o) => runCommand(o));
    let iters = 0;
    for (let i = 0; i < 3000 && testSemaphoreState().running < 1; i++) { await new Promise(r => setTimeout(r, 10)); iters++; }
    console.error("T4 iters:", iters, "state:", JSON.stringify(testSemaphoreState()));
    const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300, forceWait: true }, (o) => runCommand(o));
    console.error("T4 ok:", waiter.ok, "text:", String(waiter.text).slice(0, 120).replace(/\n/g, "/"));
    await blocker;
  });
});
