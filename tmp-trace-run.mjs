// フルスイート内でのT4トレース: exec-semaphore.test.jsのコピーを名前だけ替えて走らせる
import { execFileSync } from "node:child_process";
import { runCommand } from "./src/engine/exec.js";
import { resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState } from "./src/engine/test-semaphore.js";

resetTestSemaphore();
setTestMaxConcurrent(1);
const outer = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 60000 });
for (let i = 0; i < 200 && testSemaphoreState().running < 1; i++) await new Promise((r) => setTimeout(r, 10));
console.log("outer running:", JSON.stringify(testSemaphoreState()));
try {
  const r = execFileSync(process.execPath, ["--test", "--test-force-exit", "tmp-sem-trace2.test.js"], { encoding: "utf8", timeout: 55000 });
  console.log(r.split("\n").filter(l => /TRACE|✔|✖/.test(l)).join("\n"));
} catch (e) {
  const out = (e.stdout || "") + (e.stderr || "");
  console.log("child failed:\n" + out.split("\n").filter(l => /TRACE|✔|✖/.test(l)).slice(0, 12).join("\n"));
}
await outer;
