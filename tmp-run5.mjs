// テストの 実行を infra無しの直接importで行う(node:test runnerが絡む問題を切り分け)
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { createTools } from "./src/engine/tools.js";

const base = mkdtempSync(join(tmpdir(), "confw-"));
try {
  const main = join(base, "main"); const ws = join(base, "wt");
  mkdirSync(main, { recursive: true });
  execSync("git init -q -b main", { cwd: main, stdio: "ignore" });
  execSync("git config user.email t@t && git config user.name t", { cwd: main, stdio: "ignore" });
  writeFileSync(join(main, "package.json"), "{}\n");
  execSync("git add -A && git commit -qm init", { cwd: main, stdio: "ignore" });
  mkdirSync(ws, { recursive: true });
  execSync("git clone -q \"" + main + "\" \"" + ws + "\"", { cwd: base, stdio: "ignore" });
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const created = tasks.create({ id: "cw1", role: "impl", body: "work" });
  process.stdout.write("1-created:" + created + " open:" + readdirSync(join(ws, "tasks/open")).join(",") + "\n");
  const approvals = { require: true, pickReviewer() { return { id: "beta", role: "review" }; }, pending: new Map() };
  const postedA = []; const postedB = [];
  const mkBoard = (posted) => ({ post(role, text) { posted.push(text); }, on() { return () => {}; } });
  const alpha = createTools({ agent: { id: "alpha", displayName: "実装係", role: "impl", personaText: "#a" }, workspace: ws, mainWorkspace: main, board: mkBoard(postedA), tasks, bus, approvals, modelPolicy: { escalationThreshold: 1, escalateModel: null } });
  const c1 = await alpha.execute("claim_next_task", {});
  process.stdout.write("2-c1:" + c1.ok + " claimed:" + readdirSync(join(ws, "tasks/claimed")).join(",") + "\n");
  const f1 = await alpha.execute("finish_task", { task_id: "cw1" });
  process.stdout.write("3-f1:" + String(f1.text).slice(0, 50).replace(/\n/g, " ") + "\n");
  process.stdout.write("4-pending:" + (approvals.pending.get("cw1") ? "yes" : "no") + " open:" + readdirSync(join(ws, "tasks/open")).join(",") + "\n");
  const beta = createTools({ agent: { id: "beta", displayName: "検証係", role: "review", personaText: "#b" }, workspace: ws, mainWorkspace: main, board: mkBoard(postedB), tasks, bus, approvals, modelPolicy: { escalationThreshold: 1, escalateModel: null } });
  const c2 = await beta.execute("claim_next_task", {});
  process.stdout.write("5-c2:" + c2.ok + " text:" + String(c2.text).slice(0, 40).replace(/\n/g, " ") + "\n");
  const r = await beta.execute("finish_task", { task_id: "verify-cw1" });
  process.stdout.write("6-r:" + r.ok + " text:" + String(r.text ?? "").slice(0, 60).replace(/\n/g, " ") + "\n");
  process.stdout.write("7-postedB:" + postedB.filter((t) => /エスカレーション推奨/.test(t)).length + "件\n");
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch {}
}
