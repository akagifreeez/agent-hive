// respawn-chat失敗の再現最小化(ワークスペース内で実行)
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChat } from "./src/runner.js";
import { Bus } from "./src/engine/board.js";
import { runCommand } from "./src/engine/exec.js";

const ws = mkdtempSync(join(tmpdir(), "hive-dbg-"));
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
const wtPath = join(root, "crashy-alpha");
console.log("wt exists:", existsSync(wtPath));
if (existsSync(root)) console.log("root dirs:", readdirSync(root).join(","));
writeFileSync(join(wtPath, "half-done.txt"), "crashed work\n");
await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m "wip-crash"`, cwd: wtPath, outputLimit: 500 });
const bus2 = new Bus();
await runChat({ config, bus: bus2, modelFactory });
const openDir = join(ws, "tasks", "open");
console.log("open dir exists:", existsSync(openDir));
if (existsSync(openDir)) console.log("open files:", readdirSync(openDir).join(","));
try { rmSync(ws, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); } catch {}
