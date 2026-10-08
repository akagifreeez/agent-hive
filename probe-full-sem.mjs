// フルスイート環境シミュレーション: 外側でセマフォスロットを保持しながら
// exec-semaphore.test.js 相当のタイムアウトテストを走らせる
import { runCommand } from "./src/engine/exec.js";
import { resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState, runTestCommand } from "./src/engine/test-semaphore.js";

resetTestSemaphore();
setTestMaxConcurrent(1);
// 外側(親)がrunCommandでslowフィクスチャを実行中=スロット掴んでいる体
const outer = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 60000 });
for (let i = 0; i < 200 && testSemaphoreState().running < 1; i++) await new Promise((r) => setTimeout(r, 10));
console.log("outer running:", testSemaphoreState().running);

// 子(テストファイル相当)を別プロセスで起動
import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, ["--test", "--test-force-exit", "test/exec-semaphore.test.js"], { encoding: "utf8", timeout: 120000 });
console.log("child status:", r.status);
const lines = (r.stdout || "").split("\n").filter((l) => l.includes("✔") || l.includes("✖"));
console.log(lines.join("\n"));
await outer;
