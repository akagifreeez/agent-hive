// makeConflict込み・tools.js経由の最小再現(差分はmakeConflictだけ)
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
const base = mkdtempSync(join(tmpdir(), "mkconf-"));
try {
  const { main, ws } = initRepos(base);
  makeConflict(main, ws);
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  process.stdout.write("A-open:" + readdirSync(join(ws, "tasks/open")).join(",") + "\n");
  const created = tasks.create({ id: "cw1", role: "impl", body: "work" });
  process.stdout.write("B-created:" + created + " open:" + readdirSync(join(ws, "tasks/open")).join(",") + "\n");
  const c = tasks.claim({ id: "alpha", role: "impl" });
  process.stdout.write("C-claim:" + (c ? c.id : "null") + "\n");
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch {}
}
