import { runCommand } from "./src/engine/exec.js";
import { setSemaphoreSelfBlockGuard, resetTestSemaphore, setTestMaxConcurrent, testSemaphoreState } from "./src/engine/test-semaphore.js";
resetTestSemaphore();
setTestMaxConcurrent(1);
// ガード解除(本番経路): slowでスロットを握る
setSemaphoreSelfBlockGuard(false);
const hold = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000 });
for (let i = 0; i < 100 && testSemaphoreState().running < 1; i++) {
  await new Promise((r) => setTimeout(r, 10));
}
console.log("after hold: state=", JSON.stringify(testSemaphoreState()));
const t0 = Date.now();
const waiter = await runCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 300 });
console.log("waiter: ok=", waiter.ok, "elapsed=", Date.now()-t0);
console.log("waiter.text=", JSON.stringify(waiter.text.slice(0,150)));
console.log("after waiter: state=", JSON.stringify(testSemaphoreState()));
process.exit(0);
