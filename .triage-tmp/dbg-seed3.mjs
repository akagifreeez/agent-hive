import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";

const ws = mkdtempSync(join(tmpdir(), "hive-seed3-"));
const tasks = new TaskBlackboard(ws, new Bus());
// 1回目: base→impl→verify を作り、base/implだけ完了
tasks.seed([
  { id: "base", body: "b" },
  { id: "impl-stats", body: "i", dependsOn: ["base"] },
  { id: "verify-stats", body: "v", dependsOn: ["impl-stats"] },
]);
tasks.claim({ id: "w1", role: null });
tasks.finish({ id: "w1" }, "base");
tasks.claim({ id: "w2", role: null });
tasks.finish({ id: "w2" }, "impl-stats");
console.log("open1:", readdirSync(join(ws, "tasks", "open")), "done1:", readdirSync(join(ws, "tasks", "done")));

// 2回目: seed再投入
tasks.seed([
  { id: "base", body: "b2" },
  { id: "impl-stats", body: "i2", dependsOn: ["base"] },
  { id: "verify-stats", body: "v2", dependsOn: ["impl-stats"] },
]);
console.log("open2:", readdirSync(join(ws, "tasks", "open")));
console.log("verify file:", JSON.stringify(readFileSync(join(ws, "tasks", "open", "verify-stats.md"), "utf8")));
const got = tasks.claim({ id: "rev", role: null }, { project: "" });
console.log("claim ->", got ? got.id : null);
rmSync(ws, { recursive: true, force: true });
