// T4直後ガードoff版タイムアウトテストを「2本同時起動」で再現
import { execFileSync, spawn } from "node:child_process";
import { runCommand } from "./src/engine/exec.js";
import { resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState } from "./src/engine/test-semaphore.js";
resetTestSemaphore();
setTestMaxConcurrent(1);
const outer = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 90000 });
for (let i = 0; i < 200 && testSemaphoreState().running < 1; i++) await new Promise((r) => setTimeout(r, 10));
const args = ["--test", "--test-force-exit", "--test-name-pattern", "上限超過", "tmp-sem-trace2.test.js"];
const p1 = spawn(process.execPath, args, { encoding: "utf8" });
const p2 = spawn(process.execPath, args, { encoding: "utf8" });
let out1 = "", out2 = "";
p1.stdout.on("data", d => out1 += d); p1.stderr.on("data", d => out1 += d);
p2.stdout.on("data", d => out2 += d); p2.stderr.on("data", d => out2 += d);
const t0 = Date.now();
await Promise.all([
  new Promise(r => p1.on("close", r)),
  new Promise(r => p2.on("close", r)),
]);
console.log("both children done in", Date.now() - t0, "ms");
const f = (s, tag) => console.log(tag, s.split("\n").filter(l => /TRACE|✖|✔/.test(l)).slice(0, 8).join("\n"));
f(out1, "P1:"); f(out2, "P2:");
await outer;
