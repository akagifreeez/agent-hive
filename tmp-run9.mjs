// テストの流れを完コピで再現し、各ステップでディレクトリ状態を出す
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { createTools } from "./src/engine/tools.js";
import { rejectionCount } from "./src/engine/model-policy.js";

function GIT(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
}
function initRepos(base) {
  const main = join(base, "main");
  const ws = join(base, "wt");
  mkdirSync(main, { recursive: true });
  GIT("git init -q -b main", main);
  GIT("git config user.email t@t && git config user.name t", main);
  writeFileSync(join(main, "package.json"), '{"name":"x"}' + String.fromCharCode(10));
  GIT("git add -A && git commit -qm init", main);
  mkdirSync(ws, { recursive: true });
  GIT("git clone -q \"" + main + "\" \"" + ws + "\"", base);
  GIT("git config user.email w@t && git config user.name w", ws);
  GIT("git checkout -q -b agent/alpha", ws);
  return { main, ws };
}
function makeConflict(main, ws) {
  writeFileSync(join(ws, "README.md"), "worker side" + String.fromCharCode(10));
  GIT("git add -A && git commit -qm w1", ws);
  writeFileSync(join(main, "README.md"), "main side" + String.fromCharCode(10));
  GIT("git add -A && git commit -qm m1", main);
}
function captureBoard(posted) {
  return { post(role, text) { posted.push(text); }, on() { return () => {}; } };
}
const APPROVALS = (ws) => ({
  require: true,
  pickReviewer() { return { id: "beta", role: "review" }; },
  pending: new Map(),
});

const base = mkdtempSync(join(tmpdir(), "hive-confw-"));
try {
  const { main, ws } = initRepos(base);
  makeConflict(main, ws);
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const approvals = APPROVALS(ws);
  const postedA = [];
  const postedB = [];
  const alpha = createTools({
    agent: { id: "alpha", displayName: "実装係", role: "impl", personaText: "# a" },
    workspace: ws, mainWorkspace: main,
    board: captureBoard(postedA), tasks, bus, approvals,
    modelPolicy: { escalationThreshold: 1, escalateModel: null },
  });
  const c1 = await alpha.execute("claim_next_task", {});
  process.stdout.write("1-c1:" + c1.ok + " open:" + readdirSync(join(ws, "tasks/open")).join(",") + "\n");
  const f1 = await alpha.execute("finish_task", { task_id: "cw1" });
  process.stdout.write("2-f1:" + String(f1.text).slice(0, 40).replace(/\n/g, " ") + "\n");
  process.stdout.write("3-pending:" + (approvals.pending.get("cw1") ? "y" : "n") + " open:" + readdirSync(join(ws, "tasks/open")).join(",") + " claimed:" + readdirSync(join(ws, "tasks/claimed")).join(",") + "\n");
  const beta = createTools({
    agent: { id: "beta", displayName: "検証係", role: "review", personaText: "# b" },
    workspace: ws, mainWorkspace: main,
    board: captureBoard(postedB), tasks, bus, approvals,
    modelPolicy: { escalationThreshold: 1, escalateModel: null },
  });
  const c2 = await beta.execute("claim_next_task", {});
  process.stdout.write("4-c2:" + c2.ok + " text:" + String(c2.text).slice(0, 30).replace(/\n/g, " ") + "\n");
  const r = await beta.execute("finish_task", { task_id: "verify-cw1" });
  process.stdout.write("5-r:" + r.ok + " text:" + String(r.text ?? "").slice(0, 50).replace(/\n/g, " ") + "\n");
  process.stdout.write("6-rej:" + rejectionCount(main, "cw1") + " notice:" + postedB.filter((t) => /エスカレーション推奨/.test(t)).length + "\n");
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch {}
}
