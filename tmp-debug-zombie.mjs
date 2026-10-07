import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenario } from "./src/runner.js";
import { Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";

const ws = mkdtempSync(join(tmpdir(), "hive-dbg-"));
const tasks0 = new TaskBlackboard(ws, new Bus());
tasks0.create({ id: "impl-stats", project: "dash", body: "統計実装" });
tasks0.claim({ id: "alpha", role: null }, {});
writeFileSync(join(ws, "tasks", "claimed", `delta--impl-stats.md`), "project: dash\n\n統計実装\n");
console.log("before:", tasks0.snapshot());

const config = {
  workspace: ws,
  worktrees: { dir: `${ws}-wt` },
  agents: [
    { id: "alpha", displayName: "alpha", role: "impl", personaPath: "agents/alpha.md" },
    { id: "delta", displayName: "delta", role: "impl", personaPath: "agents/alpha.md" },
  ],
  loop: { maxTurns: 6 },
  runner: { timeoutSec: 30 },
  discovery: { probes: { tests: "off" } },
  exec: { testMaxConcurrent: 1 },
  permissions: {},
  scenario: { name: "dbg", seedFiles: [], tasks: [] },
};
const modelFactory = () => ({ async chat() { return { content: null, toolCalls: [], raw: { role: "assistant", content: null } }; } });
const bus = new Bus();
bus.on("scenario.warn", (e) => console.log("WARN:", e.message));
const snapshot = await runScenario({ config, modelFactory, bus });
console.log("after snapshot:", snapshot.tasks.claimed.filter(f => f.includes("impl-stats")));
console.log("open:", snapshot.tasks.open.filter(f => f.includes("impl-stats")));
rmSync(ws, { recursive: true, force: true });
rmSync(`${ws}-wt`, { recursive: true, force: true });
