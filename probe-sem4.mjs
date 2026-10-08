// タイムアウトテスト直前までの流れを再現: withSemaphore(1)×2 → ガードoffのタイムアウト検証
import { runCommand } from "./src/engine/exec.js";
import { resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState, runTestCommand } from "./src/engine/test-semaphore.js";
const state = () => JSON.stringify(testSemaphoreState());
async function withSem(max, fn) {
  resetTestSemaphore();
  setTestMaxConcurrent(max);
  try { await fn(); } finally { resetTestSemaphore(); setSemaphoreSelfBlockGuard(false); }
}
await withSem(1, async () => {
  const p1 = runCommand({ command: "node --test test/fixtures/empty.test.js && echo d1", timeoutMs: 15000 });
  await new Promise(r => setTimeout(r, 60));
  const p2 = runCommand({ command: "node --test test/fixtures/empty.test.js && echo d2", timeoutMs: 15000 });
  await p1; await p2;
});
console.log("after T2:", state());
await withSem(1, async () => {
  setSemaphoreSelfBlockGuard(false);
  try {
    const hold = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000 });
    for (let i = 0; i < 100 && testSemaphoreState().running < 1; i++) await new Promise(r => setTimeout(r, 10));
    const t0 = Date.now();
    const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300 }, (o) => runCommand(o));
    console.log("T3 waiter:", Date.now() - t0, "ms ok=", waiter.ok, "state=", state());
    await hold;
    const next = await runCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000 });
    console.log("T3 next ok:", next.ok);
  } finally { setSemaphoreSelfBlockGuard(true); }
});
console.log("after T3:", state());
