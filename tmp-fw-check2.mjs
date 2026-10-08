// なぜrunning=0か: blockerのrunCommand内でrunTestCommandが呼ばれるときguardはtrue(素通し&スロット加算なし)
// → 外側のセマフォには何も残らず、waiterのforceWait時には空き扱いになる。プロセス内で完結させるには
// blockerもforceWaitで実セマフォスロットを掴ませる必要がある。
import { runCommand } from "./src/engine/exec.js";
import { resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState, runTestCommand } from "./src/engine/test-semaphore.js";
import { runCommandInner } from "./src/engine/exec.js";
resetTestSemaphore(); setTestMaxConcurrent(1); setSemaphoreSelfBlockGuard(true);
const blocker = runTestCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000, forceWait: true }, runCommandInner);
for (let i = 0; i < 100 && testSemaphoreState().running < 1; i++) await new Promise(r => setTimeout(r, 10));
console.log("running:", JSON.stringify(testSemaphoreState()));
const t0 = Date.now();
const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300, forceWait: true }, runCommandInner);
console.log("waiter:", Date.now() - t0, "ms ok=", waiter.ok, "head:", waiter.text.slice(0, 40).replace(/\n/g, "/"));
await blocker;
console.log("final:", JSON.stringify(testSemaphoreState()));
