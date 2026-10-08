// 実況追認: node --test内(testランナーコンテキスト)から同コードを実行してblockerがスロットを掴むか
import { runCommand } from "./src/engine/exec.js";
import { runTestCommand, resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState } from "./src/engine/test-semaphore.js";
import { test } from "node:test";
test("probe: blocker keeps slot under node:test", async () => {
  resetTestSemaphore(); setTestMaxConcurrent(1); setSemaphoreSelfBlockGuard(true);
  const blocker = runTestCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000, forceWait: true }, (o) => runCommand(o));
  for (let i = 0; i < 100 && testSemaphoreState().running < 1; i++) await new Promise(r => setTimeout(r, 10));
  console.error("PROBE state:", JSON.stringify(testSemaphoreState()));
  const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300, forceWait: true }, (o) => runCommand(o));
  console.error("PROBE waiter ok:", waiter.ok, "head:", String(waiter.text).slice(0, 50).replace(/\n/g, "/"));
  await blocker;
});
