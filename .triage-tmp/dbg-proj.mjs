import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";

const ws = mkdtempSync(join(tmpdir(), "hive-proj-"));
const tasks = new TaskBlackboard(ws, new Bus());
tasks.seed([{ id: "verify-x", project: "lab-lessons", body: "v", dependsOn: [] }]);
console.log("open:", tasks.list().open.map(t => [t.id, t.project, t.dependsOn]));
const got = tasks.claim({ id: "rev", role: null }, { project: "lab-lessons" });
console.log("claim with project ->", got ? got.id : null);
const got2 = tasks.claim({ id: "rev2", role: null }, { project: "no-such" });
console.log("claim wrong project ->", got2 ? got2.id : null);
rmSync(ws, { recursive: true, force: true });
