// forceWait経路の単体確認: blockerがrunning=1のとき、forceWait waiterは待ちに入るか
import { runCommand } from "./src/engine/exec.js";
import { resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState, runTestCommand } from "./src/engine/test-semaphore.js";
resetTestSemaphore(); setTestMaxConcurrent(1); setSemaphoreSelfBlockGuard(true);
const blocker = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000 });
for (let i = 0; i < 100 && testSemaphoreState().running < 1; i++) await new Promise(r => setTimeout(r, 10));
console.log("running:", JSON.stringify(testSemaphoreState()));
const t0 = Date.now();
const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300, forceWait: true }, (o) => runCommand(o));
console.log("waiter:", Date.now() - t0, "ms ok=", waiter.ok, "head:", waiter.text.slice(0, 40).replace(/\n/g, "/"));
await blocker;
