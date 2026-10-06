import { execSync } from "node:child_process";
const GIT = (cmd) => { try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 }); } catch (e) { return e.stdout || ""; } };
const out = GIT("git worktree list --porcelain");
const blocks = out.split("\n\n").filter(Boolean);
console.log("blocks=" + blocks.length);
const rows = [];
for (const b of blocks) {
  const lines = b.split("\n");
  const wt = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
  if (!wt) continue;
  const name = wt.split(/[\\/]/).pop() || "";
  const branch = (lines.find((l) => l.startsWith("branch ")) || "").replace("branch refs/heads/", "");
  rows.push({ name, wt, branch });
}
// 削除候補だけ先にリストアップしてファイルへ出力(本体の重い判定は分離)
import { writeFileSync } from "node:fs";
const stale = rows.filter((r) => r.branch && r.branch !== "main" && r.branch !== "agent/glm-reasoning-content-alpha");
writeFileSync("tmp-wt-list.json", JSON.stringify(rows, null, 1));
console.log("total=" + rows.length + " stale-candidates=" + stale.length);
console.log(stale.slice(0, 8).map(r => r.name + " -> " + r.branch).join("\n"));
