import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Board, Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { createTools } from "./src/engine/tools.js";

const GIT = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
const base = mkdtempSync(join(tmpdir(), "hive-diag-"));
const main = join(base, "main");
const ws = join(base, "wt");
mkdirSync(main, { recursive: true });
GIT("git init -q -b main", main);
GIT("git config user.email t@t && git config user.name t", main);
writeFileSync(join(main, "package.json"), '{"name":"x","private":true}\n');
GIT("git add -A && git commit -qm init", main);
mkdirSync(ws, { recursive: true });
GIT(`git clone -q "${main}" "${ws}"`, base);
GIT("git config user.email w@t && git config user.name w", ws);
GIT("git checkout -q -b agent/alpha", ws);
writeFileSync(join(ws, "README.md"), "worker side\n");
GIT("git add -A && git commit -qm w1", ws);
writeFileSync(join(main, "README.md"), "main side\n");
GIT("git add -A && git commit -qm m1", main);
const bus = new Bus();
const board = new Board(bus);
const tasks = new TaskBlackboard(ws, bus);
tasks.create({ id: "cw1", role: "impl", body: "work" });
const posted = [];
const capture = { post(role, text) { posted.push(text); }, on() { return () => {}; } };
const approvals = { require: true, pending: new Map([["cw1", { agentId: "alpha", worktreePath: ws }]]), pickReviewer: () => null };
const tools = createTools({
  agent: { id: "beta", displayName: "検証係", role: "review", personaText: "# b" },
  workspace: ws, mainWorkspace: main,
  board: capture, tasks, bus, approvals, modelPolicy: { escalationThreshold: 1, escalateModel: null },
});
const c = await tools.execute("claim_next_task", {});
console.log("claim:", c.ok, String(c.text).slice(0, 120).replace(/\n/g, " | "));
console.log("claimedBy:", JSON.stringify(tasks.claimedBy("beta").map(t => t.id)));
const r = await tools.execute("finish_task", { task_id: "verify-cw1" });
console.log("finish:", r.ok, String(r.text).slice(0, 200).replace(/\n/g, " | "));
rmSync(base, { recursive: true, force: true });
