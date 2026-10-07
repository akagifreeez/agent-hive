// 一時デバッグスクリプト(検証後に削除)。ゾンビ回収テストの失敗原因を絞る。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenario } from "./src/runner.js";
import { Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";

const PERSONA = "agents/alpha.md";
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch {} }

const ws = mkdtempSync(join(tmpdir(), "hive-scen-dbg-"));
const tasks0 = new TaskBlackboard(ws, new Bus());
tasks0.create({ id: "impl-stats", project: "dash", body: "統計実装" });
tasks0.claim({ id: "alpha", role: null });
mkdirSync(join(ws, "tasks", "claimed"), { recursive: true });
writeFileSync(join(ws, "tasks", "claimed", "delta--impl-stats.md"), "project: dash\n\n統計実装(alpha側と同内容)\n");
console.log("before claimed:", tasks0.list().claimed.map((t) => t.path));

const bus = new Bus();
bus.on("task.released", (e) => console.log("EVT task.released:", JSON.stringify(e)));
bus.on("scenario.warn", (e) => console.log("EVT scenario.warn:", e.message));
const modelFactory = () => ({ async chat() { return { content: null, toolCalls: [], raw: { role: "assistant", content: null } }; } });
const snapshot = await runScenario({ config: {
  workspace: ws, worktrees: { dir: `${ws}-wt` },
  agents: [
    { id: "alpha", displayName: "alpha", role: "impl", personaPath: PERSONA },
    { id: "delta", displayName: "delta", role: "impl", personaPath: PERSONA },
  ],
  loop: { maxTurns: 6 }, runner: { timeoutSec: 30 },
  discovery: { probes: { tests: "off" } }, exec: { testMaxConcurrent: 1 },
  permissions: {}, scenario: { name: "lab-lessons", seedFiles: [], tasks: [] },
}, modelFactory, bus });
console.log("after claimed:", snapshot.tasks.claimed.map((t) => t.path));
console.log("after open:", snapshot.tasks.open.map((t) => t.path));
console.log("done files:", snapshot.tasks.done.filter((t) => t.id.includes("impl-stats")).map((t) => t.path));
rmTree(ws); rmTree(ws + "-wt");
