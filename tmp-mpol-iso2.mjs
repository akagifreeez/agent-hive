// approve_task競合→差し戻し記録+エスカレーション投稿の分離検証
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { createTools } = await import("./src/engine/tools.js");
const { Board, Bus } = await import("./src/engine/board.js");
const { TaskBlackboard } = await import("./src/engine/tasks.js");
const { ensureGitRepo } = await import("./src/engine/discover.js");
const { createWorktree } = await import("./src/engine/worktree.js");
const { runCommand } = await import("./src/engine/exec.js");
const { readModelPolicy, rejectionCount } = await import("./src/engine/model-policy.js");

const main = mkdtempSync(join(tmpdir(), "iso2-main-"));
const wt = `${main}-wt`;
try {
  await ensureGitRepo(main);
  const commit = () => runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: main, outputLimit: 500 });
  writeFileSync(join(main, "f.txt"), "base\n");
  await commit();
  await createWorktree({ mainWorkspace: main, worktreeRoot: wt, agentId: "mpola" });
  writeFileSync(join(main, "conflict.txt"), "main side\n");
  await commit();

  const bus = new Bus();
  const posts = [];
  bus.on("board", (p) => posts.push(p));
  const board = new Board(bus, "iso2");
  const tasks = new TaskBlackboard(main, bus);
  const approvals = {
    require: true,
    pending: new Map(),
    pickReviewer(excludeId) { return excludeId === "rv" ? { id: "mpola", role: "impl" } : { id: "rv", role: "review" }; },
  };
  const lead = { id: "lead", displayName: "リーダー", role: "lead", personaText: "# L" };
  const leadTools = createTools({ agent: lead, workspace: wt, mainWorkspace: main, board, tasks, bus, approvals });
  tasks.create({ id: "c1", body: "競合する仕事" });
  await leadTools.execute("claim_next_task", {});
  writeFileSync(join(wt, "conflict.txt"), "wt side\n");
  await leadTools.execute("finish_task", { task_id: "c1" });

  const reviewer = { id: "rv", displayName: "レビュアー", role: "review", personaText: "# R" };
  const rvTools = createTools({
    agent: reviewer, workspace: main, mainWorkspace: main, board, tasks, bus, approvals,
    modelPolicy: readModelPolicy({ chat: { modelPolicy: { escalationThreshold: 1 } } }),
  });
  tasks.create({ id: "verify-c1", role: "review", body: "検証する" });
  await rvTools.execute("claim_next_task", { project: "" });
  const appr = await rvTools.execute("approve_task", { task_id: "c1" });
  console.log("approve ok=", appr.ok, "| conflict text=", String(appr.text).includes("競合"));
  console.log("rejectionCount=", rejectionCount(main, "c1"));
  const esc = posts.find((p) => String(p.text ?? "").includes("モデル選択エスカレーション推奨"));
  console.log("esc posted=", Boolean(esc), "| quota=", esc ? esc.text.includes("同時1タスクまで") : false);
} finally {
  for (const d of [main, wt]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
