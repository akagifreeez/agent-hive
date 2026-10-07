import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBlackBox } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";

const ws = mkdtempSync(join(tmpdir(), "hive-meta-"));
const tasks = new TaskBlackBox(ws, new Bus());
tasks.seed([{ id: "verify-y", project: "lab-lessons", body: "検証", dependsOn: ["impl-stats"] }]);
const raw = readFileSync(join(ws, "tasks", "open", "verify-y.md"), "utf8");
console.log("raw head:", JSON.stringify(raw.split("\n").slice(0, 4)));
rmSync(ws, { recursive: true, force: true });
