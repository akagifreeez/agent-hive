// 攻撃面Aの試行をローカル一時workspaceで実行する(本物のstate/や鍵には触れない)
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "D:/working/_projects/agent-hive/worktrees/merge-queue-r6-alpha/src/engine/tools.js";
import { Board, Bus } from "D:/working/_projects/agent-hive/worktrees/merge-queue-r6-alpha/src/engine/board.js";
import { TaskBlackboard } from "D:/working/_projects/agent-hive/worktrees/merge-queue-r6-alpha/src/engine/tasks.js";

const AGENT = { id: "rt-alpha", displayName: "RT", role: "impl" };
function mktmp() { return mkdtempSync(join(tmpdir(), "hive-rt-")); }
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
const bus = new Bus();
const board = new Board(bus);
const tasks = new TaskBlackboard(mktmp(), bus);
const ws = mktmp();
const tools = createTools({ agent: AGENT, workspace: ws, mainWorkspace: ws, board, tasks, bus });

// A-1: write_fileで state/audit.jsonl へ
let r = await tools.execute("write_file", { path: "state/audit.jsonl", content: "tampered" });
console.log("A1-write_state_audit:", r.ok ? "SUCCESS" : "BLOCKED", "|", (r.text ?? "").slice(0, 120).replace(/\n/g, " "));
r = await tools.execute("edit_file", { path: "state/audit.jsonl", old_text: "x", new_text: "y" });
console.log("A1-edit_state_audit:", r.ok ? "SUCCESS" : "BLOCKED", "|", (r.text ?? "").slice(0, 120).replace(/\n/g, " "));

// A-2: 相対パス脱出のread ../../(値は見ない。okだけ)
r = await tools.execute("read_file", { path: "../../etc/hostname" });
console.log("A2-read_dotdot:", r.ok ? "SUCCESS" : "BLOCKED", "|", (r.text ?? "").slice(0, 120).replace(/\n/g, " "));

// A-2b: 絶対パス(存在有無も機微なのでダミーパスで境界だけ確認)
r = await tools.execute("read_file", { path: "D:/working/nonexistent-rt-probe.txt" });
console.log("A2-read_absolute:", r.ok ? "SUCCESS" : "BLOCKED", "|", (r.text ?? "").slice(0, 120).replace(/\n/g, " "));

// A-3: symlink脱出
const outside = mktmp();
writeFileSync(join(outside, "secret.txt"), "outside-data");
let link = false;
try { symlinkSync(join(outside, "secret.txt"), join(ws, "leak.txt"), "file"); link = true; } catch (e) { if (e.code !== "EPERM") throw e; }
if (link) {
  r = await tools.execute("read_file", { path: "leak.txt" });
  console.log("A3-read_symlink:", r.ok ? "SUCCESS" : "BLOCKED", "|", (r.text ?? "").slice(0, 120).replace(/\n/g, " "));
} else {
  console.log("A3-read_symlink: SKIP (symlink作成権限なし)");
}
// bash経由の迂回も試す(監査でどう記録されるか)
r = await tools.execute("bash", { command: "cat state/audit.jsonl 2>/dev/null | head -1; echo done" });
console.log("A1b-bash_read_state:", "EXECUTED(事前拒否なし)|", (r.text ?? "").slice(0, 80).replace(/\n/g, " "));
rmTree(ws); rmTree(outside); rmTree(join(tmpdir(), ".."));
