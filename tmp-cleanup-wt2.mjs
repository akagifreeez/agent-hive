import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const GIT = (cmd) => { try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }); } catch (e) { return e.stdout || ""; } };
const rows = JSON.parse(readFileSync("tmp-wt-list.json", "utf8"));
const mine = "agent/glm-reasoning-content-alpha";
const results = [];
let removed = 0, kept = 0;
for (const r of rows) {
  if (r.name === "agent-hive") continue;
  if (r.branch === mine) continue;
  let status = "keep";
  if (!r.branch) { status = "detached"; }
  else {
    GIT("git merge-base --is-ancestor \"" + r.branch + "\" main");
    const anc = GIT("git rev-parse --verify \"" + r.branch + "\" 2>" + String.fromCharCode(92) + "n");
    // merge-base check via exit code trick: use bash test instead
    try { execSync("git merge-base --is-ancestor \"" + r.branch + "\" main", { stdio: "ignore", timeout: 15000 }); status = "merged"; }
    catch (e) { status = e.status === 1 ? "unmerged" : "error"; }
  }
  if (status === "merged" || status === "detached") {
    try { execSync("git worktree remove --force \"" + r.wt + "\"", { stdio: "ignore", timeout: 20000 }); removed++; results.push("removed " + r.name + " (" + status + ")"); }
    catch (e) { kept++; results.push("FAILED " + r.name); }
  } else { kept++; }
}
writeFileSync("tmp-wt-cleanup-result.json", JSON.stringify({ removed, kept, results }, null, 1));
console.log("removed=" + removed + " kept=" + kept);
console.log(results.slice(0, 6).join("\n"));
