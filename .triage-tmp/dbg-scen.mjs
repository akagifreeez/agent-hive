import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "../src/runner.js";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");
const ws = mkdtempSync(join(tmpdir(), "hive-dbg-"));
const tasks0 = new TaskBlackboard(ws, new Bus());
tasks0.create({ id: "impl-stats", project: "dash", body: "stats" });
tasks0.claim({ id: "alpha", role: null });
mkdirSync(join(ws, "tasks", "claimed"), { recursive: true });
writeFileSync(join(ws, "tasks", "claimed", "delta--impl-stats.md"), "project: dash\n\nstats dup\n");
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
  scenario: { name: "dbg", seedFiles: [], tasks: [] },
};
let never = 0;
const modelFactory = () => ({ async chat() { never++; return { content: null, toolCalls: [], raw: { role: "assistant", content: null } }; } });
const bus = new Bus();
bus.on("scenario.warn", (e) => console.log("WARN:", e.message?.slice(0, 200)));
try {
  const snap = await runScenario({ config, modelFactory, bus });
  console.log("chat calls:", never);
  console.log("claimed:", snap.tasks.claimed);
  console.log("open:", snap.tasks.open);
  console.log("done:", snap.tasks.done);
  console.log("results:", snap.results.map(r => ({ ok: r.ok, endedBy: r.endedBy, error: r.error })));
} catch (e) {
  console.log("THREW:", e.message);
}
console.log("dir claimed:", existsSync(join(ws, "tasks", "claimed")) ? readdirSync(join(ws, "tasks", "claimed")) : "(none)");
console.log("dir open:", readdirSync(join(ws, "tasks", "open")));
console.log("dir done:", readdirSync(join(ws, "tasks", "done")));
rmSync(ws, { recursive: true, force: true });
try { rmSync(ws + "-wt", { recursive: true, force: true }); } catch {}
