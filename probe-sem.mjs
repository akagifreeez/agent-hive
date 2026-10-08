import { setTestMaxConcurrent, resetTestSemaphore, setSemaphoreSelfBlockGuard, testSemaphoreState, runTestCommand } from "./src/engine/test-semaphore.js";
import { runCommandInner } from "./src/engine/exec.js";
import assert from "node:assert/strict";

resetTestSemaphore();
setTestMaxConcurrent(1);
setSemaphoreSelfBlockGuard(false);

// blocker: guard off, 直接runTestCommandで走らせる(スロットを掴ませる)
const blocker = runTestCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000 }, runCommandInner);
for (let i = 0; i < 200 && testSemaphoreState().running < 1; i++) {
  await new Promise((r) => setTimeout(r, 10));
}
console.log("running after blocker:", testSemaphoreState().running, "queue:", testSemaphoreState().queueLen ?? JSON.stringify(testSemaphoreState()));

// waiter: queueTimeoutMs=300
const t0 = Date.now();
const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300 }, runCommandInner);
console.log("waiter took", Date.now() - t0, "ms ok=", waiter.ok);
console.log("text:", waiter.text.slice(0, 200));
await blocker;
console.log("final state:", JSON.stringify(testSemaphoreState()));
