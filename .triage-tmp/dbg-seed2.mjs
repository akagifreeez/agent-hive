import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "../src/runner.js";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");
const ws = mkdtempSync(join(tmpdir(), "hive-seed2-"));
const config = {
  workspace: ws,
  worktrees: { dir: ws + "-wt" },
  agents: [
    { id: "alpha", displayName: "alpha", role: "impl", personaPath: PERSONA },
    { id: "delta", displayName: "delta", role: "impl", personaPath: PERSONA },
  ],
  loop: { maxTurns: 6 },
  runner: { timeoutSec: 30 },
  discovery: { probes: { tests: "off" } },
  exec: { testMaxConcurrent: 1 },
  permissions: {},
  scenario: { name: "lab-lessons", seedFiles: [], tasks: [] },
};
config.scenario.tasks = [
  { id: "base", body: "基盤" },
  { id: "impl-stats", body: "統計", dependsOn: ["base"] },
  { id: "verify-stats", body: "検証", dependsOn: ["impl-stats"] },
];
const t0 = new TaskBlackboard(ws, new Bus());
t0.seed(config.scenario.tasks);
t0.claim({ id: "w1", role: null });
t0.finish({ id: "w1" }, "base");
t0.claim({ id: "w2", role: null });
t0.finish({ id: "w2" }, "impl-stats");
console.log("pre done:", readdirSync(join(ws, "tasks", "done")));

const bus = new Bus();
const modelFactory = () => ({ async chat() { return { content: null, toolCalls: [], raw: { role: "assistant", content: null } }; } });
const snap = await runScenario({ config, modelFactory, bus });
console.log("open after:", readdirSync(join(ws, "tasks", "open")));
console.log("done after:", readdirSync(join(ws, "tasks", "done")));
const t = new TaskBlackboard(ws, new Bus());
const got = t.claim({ id: "rev", role: null }, { project: "lab-lessons" });
console.log("claim verify-stats ->", got ? got.id : null);
rmSync(ws, { recursive: true, force: true });
try { rmSync(ws + "-wt", { recursive: true, force: true }); } catch {}
