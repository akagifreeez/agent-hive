import { runCommand } from "./src/engine/exec.js";
import { setSemaphoreSelfBlockGuard, resetTestSemaphore, setTestMaxConcurrent, testSemaphoreState } from "./src/engine/test-semaphore.js";
resetTestSemaphore();
setTestMaxConcurrent(1);
setSemaphoreSelfBlockGuard(true);
const t0 = Date.now();
const r = await runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000 });
console.log("guard ON: ok=", r.ok, "elapsed=", Date.now()-t0, "state=", JSON.stringify(testSemaphoreState()));
