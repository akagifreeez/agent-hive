// テストのinitReposを正確に再現(GIT helper + stdio設定違い)して差分を探す
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";

function GIT(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
}
const base = mkdtempSync(join(tmpdir(), "confw2-"));
try {
  const main = join(base, "main"); const ws = join(base, "wt");
  mkdirSync(main, { recursive: true });
  GIT("git init -q -b main", main);
  GIT("git config user.email t@t && git config user.name t", main);
  writeFileSync(join(main, "package.json"), '{"name":"x"}' + String.fromCharCode(10));
  GIT("git add -A && git commit -qm init", main);
  mkdirSync(ws, { recursive: true });
  GIT("git clone -q \"" + main + "\" \"" + ws + "\"", base);
  GIT("git config user.email w@t && git config user.name w", ws);
  GIT("git checkout -q -b agent/alpha", ws);
  process.stdout.write("1-clone-ok open dir? " + readdirSync(ws).join(",") + "\n");
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const created = tasks.create({ id: "cw1", role: "impl", body: "work" });
  process.stdout.write("2-created:" + created + " open:" + readdirSync(join(ws, "tasks/open")).join(",") + "\n");
  const c = tasks.claim({ id: "alpha", role: "impl" });
  process.stdout.write("3-claim:" + (c ? c.id : "null") + "\n");
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch {}
}
