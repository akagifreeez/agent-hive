// tools.jsのdispatchを直接呼ばず、TaskBlackboardの生成タイミングを変えて検証
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { createTools } from "./src/engine/tools.js";

function GIT(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
}
const base = mkdtempSync(join(tmpdir(), "timing-"));
const main = join(base, "main"); const ws = join(base, "wt");
mkdirSync(main, { recursive: true });
GIT("git init -q -b main", main);
GIT("git config user.email t@t && git config user.name t", main);
writeFileSync(join(main, "package.json"), '{"name":"x"}\n');
GIT("git add -A && git commit -qm init", main);
mkdirSync(ws, { recursive: true });
GIT("git clone -q \"" + main + "\" \"" + ws + "\"", base);
GIT("git config user.email w@t && git config user.name w", ws);
GIT("git checkout -q -b agent/alpha", ws);
// 競合工作は省略(claimの挙動を見たいだけ)
const bus = new Bus();
const tasks = new TaskBlackboard(ws, bus);
process.stdout.write("A-open:" + readdirSync(join(ws, "tasks/open")).join(",") + "\n");
const approvals = { require: true, pickReviewer() { return { id: "beta", role: "review" }; }, pending: new Map() };
const board = { post() {}, on() { return () => {}; } };
const alpha = createTools({ agent: { id: "alpha", displayName: "実装係", role: "impl", personaText: "# a" }, workspace: ws, mainWorkspace: main, board, tasks, bus, approvals, modelPolicy: { escalationThreshold: 1, escalateModel: null } });
const created = tasks.create({ id: "cw1", role: "impl", body: "work" });
process.stdout.write("B-created:" + created + " open:" + readdirSync(join(ws, "tasks/open")).join(",") + "\n");
const c1 = await alpha.execute("claim_next_task", {});
process.stdout.write("C-c1:" + c1.ok + " text:" + String(c1.text).slice(0, 25).replace(/\n/g, " ") + " claimed:" + readdirSync(join(ws, "tasks/claimed")).join(",") + "\n");
rmSync(base, { recursive: true, force: true });
