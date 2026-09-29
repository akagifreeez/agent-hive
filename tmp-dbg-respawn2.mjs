// 本物のテスト手順を再現+内部観測
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChat } from "./src/runner.js";
import { Bus } from "./src/engine/board.js";
import { runCommand } from "./src/engine/exec.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
const ws = mkdtempSync(join(tmpdir(), "hive-dbg2-"));
const root = `${ws}-wt`;
const config = {
  workspace: ws, worktrees: { dir: root },
  model: { contextWindow: 200000, maxTokens: 4000 },
  loop: { maxTurns: 10 }, budget: null, compact: { thresholdPercent: 90 },
  discovery: {}, permissions: {}, scenario: { name: "test" },
  chat: { lead: "lead", workers: ["alpha", "beta", "gamma"], maxTurnsPerRound: 8, staggerMs: 5 },
  agents: [
    { id: "alpha", displayName: "アルファ", role: "impl" },
    { id: "beta", displayName: "ベータ", role: "review" },
    { id: "gamma", displayName: "ガンマ", role: "impl" },
  ],
};
const modelFactory = () => ({ maxTokens: 4000, async chat() { return { content: "ok", toolCalls: [], raw: { content: "ok" }, usage: { promptTokens: 10, completionTokens: 1 } }; } });
const ctl1 = await runChat({ config, bus: new Bus(), modelFactory });
await ctl1.openThread({ project: "crashy", goal: "中断されるスレッド" });
const wtPath = join(root, "crashy-alpha");
console.log("[dbg] wt exists:", existsSync(wtPath));
writeFileSync(join(wtPath, "half-done.txt"), "crashed work\n");
await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m "wip-crash"`, cwd: wtPath, outputLimit: 500 });
const bus2 = new Bus();
bus2.on("board", (p) => { if (String(p.text).includes("スキャン") || String(p.text).includes("worktree")) console.log("[dbg board]", String(p.text).split("\n")[0]); });
bus2.on("scenario.warn", (p) => console.log("[dbg warn]", p.message));
bus2.on("task.created", (p) => console.log("[dbg task.created]", p.taskId ?? p.id));
await runChat({ config, bus: bus2, modelFactory });
const openDir = join(ws, "tasks", "open");
console.log("[dbg] open files:", existsSync(openDir) ? readdirSync(openDir).join(",") : "(none)");
rmTree(ws); rmTree(root);
