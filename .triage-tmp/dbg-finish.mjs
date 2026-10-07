import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";

const ws = mkdtempSync(join(tmpdir(), "hive-finish-"));
const tasks = new TaskBlackboard(ws, new Bus());
tasks.seed([{ id: "base", project: "P", body: "b" }]);
const g = tasks.claim({ id: "w1", role: null });
console.log("claimed dir:", readdirSync(join(ws, "tasks", "claimed")));
const r = tasks.finish({ id: "w1" }, "base");
console.log("finish ->", r);
console.log("done dir:", readdirSync(join(ws, "tasks", "done")));
console.log("claimed dir after:", readdirSync(join(ws, "tasks", "claimed")));
console.log("isUnresolved base:", tasks.isUnresolved("base"));
rmSync(ws, { recursive: true, force: true });
