import { test } from "node:test";
import { runCommand, runCommandInner } from "./src/engine/exec.js";
import { runTestCommand, setSemaphoreSelfBlockGuard, resetTestSemaphore, setTestMaxConcurrent, testSemaphoreState } from "./src/engine/test-semaphore.js";
test("state probe", async () => {
  setSemaphoreSelfBlockGuard(true);
  resetTestSemaphore(); setTestMaxConcurrent(1);
  setSemaphoreSelfBlockGuard(false);
  const st0 = testSemaphoreState();
  const hold = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000 });
  for (let i = 0; i < 200 && testSemaphoreState().running < 1; i++) await new Promise((r) => setTimeout(r, 10));
  const st1 = testSemaphoreState();
  const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300 }, runCommandInner);
  const st2 = testSemaphoreState();
  console.log("PROBE st0=", JSON.stringify(st0), "st1=", JSON.stringify(st1), "st2=", JSON.stringify(st2), "waiter.ok=", waiter.ok, "text0=", String(waiter.text).slice(0, 60));
  await hold;
  resetTestSemaphore(); setSemaphoreSelfBlockGuard(true);
});
