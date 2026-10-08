// 一時診断: runTestCommand直呼びのタイムアウト誘発を単体プロセスで確認
import { runCommand } from "./src/engine/exec.js";
import { runTestCommand, setTestMaxConcurrent, testSemaphoreState, resetTestSemaphore } from "./src/engine/test-semaphore.js";
resetTestSemaphore();
setTestMaxConcurrent(1);
const blocker = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000 });
for (let i = 0; i < 100 && testSemaphoreState().running < 1; i++) await new Promise((r) => setTimeout(r, 10));
console.log("state before waiter:", JSON.stringify(testSemaphoreState()));
const t0 = Date.now();
const waiter = await runTestCommand(
  { command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300 },
  (o) => runCommand(o),
);
console.log("elapsed:", Date.now() - t0, "ok:", waiter.ok, "text head:", waiter.text.slice(0, 100).replace(/\n/g, " / "));
await blocker;
console.log("state after:", JSON.stringify(testSemaphoreState()));
