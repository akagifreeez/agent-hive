// scenario-robustness再現: 2回目seed時にclaimがブロックされるか
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
const ws = mkdtempSync(join(tmpdir(), "seed-"));
const config = { scenario: { name: "lab-lessons", tasks: [
  { id: "base", body: "x" },
  { id: "impl-stats", body: "y", dependsOn: ["base"] },
  { id: "verify-stats", body: "z", dependsOn: ["impl-stats"] },
] } };
const t0 = new TaskBlackboard(ws, new Bus());
t0.seed(config.scenario.tasks);
t0.claim({ id: "w1", role: null }); t0.finish({ id: "w1" }, "base");
t0.claim({ id: "w2", role: null }); t0.finish({ id: "w2" }, "impl-stats");
// runScenario相当の2回目seedだけを模倣(src/runner.jsのseed呼び出しを確認するダミー)
console.log("done ids:", t0.list().done.map(t=>t.id).join(","));
const t1 = new TaskBlackboard(ws, new Bus());
const created = t1.seed(config.scenario.tasks);
console.log("2nd seed created:", JSON.stringify(created ?? "n/a"));
console.log("open:", t1.list().open.map(t=>`${t.id}${t.blocked?"(blocked)":""}`).join(","));
const got = t1.claim({ id: "reviewer", role: null }, { project: "lab-lessons" });
console.log("claim:", got?.id ?? "null");
rmSync(ws, { recursive: true, force: true });
process.exit(0);
