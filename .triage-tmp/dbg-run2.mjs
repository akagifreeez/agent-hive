import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "../src/runner.js";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");
const ws = mkdtempSync(join(tmpdir(), "hive-run2-"));
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
  scenario: { name: "lab-lessons", seedFiles: [], tasks: [
    { id: "base", body: "基盤" },
    { id: "impl-stats", body: "統計", dependsOn: ["base"] },
    { id: "verify-stats", body: "検証", dependsOn: ["impl-stats"] },
  ] },
};
const t0 = new TaskBlackboard(ws, new Bus());
t0.seed(config.scenario.tasks);
t0.claim({ id: "w1", role: null });
t0.finish({ id: "w1" }, "base");
t0.claim({ id: "w2", role: null });
t0.finish({ id: "w2" }, "impl-stats");

const bus = new Bus();
const modelFactory = () => ({ async chat() { return { content: null, toolCalls: [], raw: { role: "assistant", content: null } }; } });
const snap = await runScenario({ config, modelFactory, bus });
console.log("open after:", snap.tasks.open);
console.log("done after:", snap.tasks.done);
console.log("claimed after:", snap.tasks.claimed);
const vf = readFileSync(join(ws, "tasks", "open", "verify-stats.md"), "utf8");
console.log("verify file head:", JSON.stringify(vf.split("\n").slice(0, 3)));
const t = new TaskBlackboard(ws, new Bus());
const got = t.claim({ id: "rev", role: null }, { project: "lab-lessons" });
console.log("claim ->", got ? got.id : null);
rmSync(ws, { recursive: true, force: true });
try { rmSync(ws + "-wt", { recursive: true, force: true }); } catch {}
