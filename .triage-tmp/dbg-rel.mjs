import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";

const ws = mkdtempSync(join(tmpdir(), "hive-rel-"));
const tasks = new TaskBlackboard(ws, new Bus());
tasks.create({ id: "impl-stats", project: "dash", body: "stats" });
tasks.claim({ id: "alpha", role: null });
mkdirSync(join(ws, "tasks", "claimed"), { recursive: true });
writeFileSync(join(ws, "tasks", "claimed", "delta--impl-stats.md"), "project: dash\n\nstats dup\n");
console.log("before claimed:", readdirSync(join(ws, "tasks", "claimed")));
console.log("list claimed:", tasks.list().claimed.map(t => [t.agent, t.id]));
for (const z of tasks.list().claimed) {
  const ok = tasks.releaseOne(z.agent, z.id, "[起動時回収] テスト");
  console.log("releaseOne", z.agent, z.id, "->", ok);
}
console.log("after claimed:", readdirSync(join(ws, "tasks", "claimed")));
console.log("after open:", readdirSync(join(ws, "tasks", "open")));
console.log("after done:", readdirSync(join(ws, "tasks", "done")));
rmSync(ws, { recursive: true, force: true });
