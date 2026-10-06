// scriptedModelのプローブ: loop内でclaimMissesが3に達してidle退場するか観る
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { ChatHost } from "./src/engine/chat.js";
import { createTools } from "./src/engine/tools.js";
import { ensureGitRepo } from "./src/engine/discover.js";
import { createWorktree } from "./src/engine/worktree.js";
import { runCommand } from "./src/engine/exec.js";
import assert from "node:assert/strict";

function mktmp() { return mkdtempSync(join(tmpdir(), "hive-probe-")); }
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
function scriptedModel(text) {
  return { maxTokens: 100, async chat() { return { content: text, toolCalls: [], raw: { content: text }, usage: { promptTokens: 1, completionTokens: 1 } }; } };
}
async function commitIn(dir, msg) {
  await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m "${msg}"`, cwd: dir, outputLimit: 500 });
}
const ws = mktmp(); const wtRoot = `${ws}-wt`;
await ensureGitRepo(ws);
writeFileSync(join(ws, "base.txt"), "base\n");
await commitIn(ws, "base");
const wtA = await createWorktree({ mainWorkspace: ws, worktreeRoot: wtRoot, agentId: "alpha" });
const bus = new Bus();
const posts = [];
bus.on("board", (p) => posts.push(p));
bus.on("agent.status", (p) => posts.push({ agent: "STATUS", text: `${p.agent}:${p.status}` }));
bus.on("usage.round", (p) => posts.push({ agent: "USAGE", text: `${p.agent}:${p.endedBy}` }));
const board = new Board(bus, "approvals");
const tasks = new TaskBlackboard(ws, bus);
const approvals = { require: true, pending: new Map(), pickReviewer() { return { id: "beta", displayName: "ベータ", role: "review" }; } };
const alpha = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
const model = scriptedModel("待機中");
const host = new ChatHost({
  mains: [alpha], mainWorkspace: ws, project: "approvals", autoContinueRounds: 0, staggerMs: 0,
  modelFactory: () => model,
  toolsFactory: (agent) => createTools({ agent, workspace: wtA, mainWorkspace: ws, board, tasks, bus, approvals }),
  board, tasks, bus, approvals,
});
host.worktreePaths = { alpha: wtA };
writeFileSync(join(wtA, "ok.txt"), "承認不要の変更\n");
await commitIn(wtA, "ok");
host.say("[テスト] ラウンド実行2");
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const st = host.roundState.get("alpha");
  if (st && !st.running) { console.log(`DONE at ${i}s`); break; }
  if (i % 4 === 3) console.log(`${i}s still running, posts=${posts.length}`);
}
console.log(posts.map((p) => `[${p.agent}] ${String(p.text).slice(0, 100)}`).join("\n"));
rmTree(ws); rmTree(wtRoot);
process.exit(0);
