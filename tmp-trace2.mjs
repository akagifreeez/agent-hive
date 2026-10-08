// T4をスキップし、guard-off版タイムアウトテストだけを走らせる(フルスイート類似環境)
import { execFileSync } from "node:child_process";
import { runCommand } from "./src/engine/exec.js";
import { resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState } from "./src/engine/test-semaphore.js";
resetTestSemaphore();
setTestMaxConcurrent(1);
const outer = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 60000 });
for (let i = 0; i < 200 && testSemaphoreState().running < 1; i++) await new Promise((r) => setTimeout(r, 10));
try {
  execFileSync(process.execPath, ["--test", "--test-force-exit", "--test-name-pattern", "上限超過", "tmp-sem-trace2.test.js"], { encoding: "utf8", timeout: 55000 });
} catch (e) {
  const out = (e.stdout || "") + "\n===ERR===\n" + (e.stderr || "");
  console.log(out.split("\n").filter(l => /TRACE|✔|✖|Error|not ok|ok \d/.test(l)).slice(0, 12).join("\n"));
}
await outer;
