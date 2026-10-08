import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";

const ws = mkdtempSync(join(tmpdir(), "hive-dep-"));
const tasks = new TaskBlackboard(ws, new Bus());
tasks.create({ id: "verify-stats", body: "v", dependsOn: ["impl-stats"] });
console.log("file:", JSON.stringify(readFileSync(join(ws, "tasks", "open", "verify-stats.md"), "utf8")));
console.log("canClaim:", tasks.canClaim("verify-stats.md"));
rmSync(ws, { recursive: true, force: true });
