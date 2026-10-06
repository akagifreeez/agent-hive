import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";
import { ensureGitRepo } from "../src/engine/discover.js";
import { createWorktree } from "../src/engine/worktree.js";
import { runCommand } from "../src/engine/exec.js";

async function commitIn(dir, msg) {
  await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m "${msg}"`, cwd: dir, outputLimit: 500 });
}

test("diag", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-diag-"));
  const wtRoot = `${ws}-wt`;
  await ensureGitRepo(ws);
  writeFileSync(join(ws, "base.txt"), "base\n");
  await commitIn(ws, "base");
  const wtA = await createWorktree({ mainWorkspace: ws, worktreeRoot: wtRoot, agentId: "alpha" });
  const bus = new Bus();
  const events = [];
  for (const ev of ["agent.status", "agent.error", "merge.completed", "board"]) {
    bus.on(ev, (p) => events.push([ev, JSON.stringify(p).slice(0, 120)]));
  }
  const board = new Board(bus, "approvals");
  const tasks = new TaskBlackboard(ws, bus);
  const approvals = { require: true, pending: new Map(), pickReviewer: () => ({ id: "beta", displayName: "ベータ", role: "review" }) };
  const alpha = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  const model = { maxTokens: 100, async chat() { return { content: "ok", toolCalls: [], raw: { content: "ok" }, usage: { promptTokens: 1, completionTokens: 1 } }; } };
  const host = new ChatHost({
    mains: [alpha], mainWorkspace: ws, project: "approvals", autoContinueRounds: 0, staggerMs: 0,
    modelFactory: () => model,
    toolsFactory: (agent) => createTools({ agent, workspace: wtA, mainWorkspace: ws, board, tasks, bus, approvals }),
    board, tasks, bus, approvals,
  });
  host.worktreePaths = { alpha: wtA };
  writeFileSync(join(wtA, "ok.txt"), "x\n");
  await commitIn(wtA, "ok");
  host.say("ラウンド実行2");
  await new Promise((r) => setTimeout(r, 8000));
  const st = host.roundState.get("alpha");
  console.log("ST:", JSON.stringify(st));
  console.log("EVENTS:", events.filter(e => e[0] !== "board").slice(0, 20).join("\n"));
  console.log("BOARD POSTS:", board.posts.map(p => `${p.from}: ${p.text.slice(0, 80)}`).join(" | "));
  rmSync(ws, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
});
