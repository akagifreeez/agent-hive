// worktree隔離: エージェントごとに独立したチェックアウト(ブランチ agent/<id>)を
// 与え、finish_task時にmainへマージする。同一ファイルの同時変更にも耐える。
// マージはリポジトリ共有のindexを叩くため、直列化して index.lock 競合を防ぐ。
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./exec.js";

let mergeChain = Promise.resolve();
function queueMerge(fn) {
  const p = mergeChain.then(fn, fn);
  mergeChain = p.then(() => {}, () => {});
  return p;
}

// 毎ランfreshに張り直す(前回のブランチ残骸を掃除)
export async function setupWorktrees({ mainWorkspace, worktreeRoot, agents, exec = runCommand }) {
  const paths = {};
  for (const agent of agents) {
    const path = resolve(join(worktreeRoot, agent.id));
    const branch = `agent/${agent.id}`;
    if (existsSync(path)) {
      await exec({ command: `git worktree remove --force '${path}'`, cwd: mainWorkspace, outputLimit: 1000 });
    }
    await exec({ command: `git branch -D ${branch} 2>/dev/null || true`, cwd: mainWorkspace, outputLimit: 1000 });
    const r = await exec({ command: `git worktree add -b ${branch} '${path}' main`, cwd: mainWorkspace, outputLimit: 2000 });
    if (!r.ok) throw new Error(`worktree作成失敗(${agent.id}): ${r.text.slice(0, 300)}`);
    paths[agent.id] = path;
  }
  return paths;
}

export function mergeAgentWork({ mainWorkspace, worktreePath, agent, taskId, exec = runCommand }) {
  const branch = `agent/${agent.id}`;
  return queueMerge(async () => {
    // 1) worktree側の未コミット変更を確定(変更がなければno-op)
    await exec({
      command: `git add -A && (git diff --cached --quiet || git -c user.name=${agent.id} -c user.email=${agent.id}@hive.local commit -m 'wip: ${taskId}')`,
      cwd: worktreePath,
      outputLimit: 2000,
    });
    // 2) mainへマージ
    const m = await exec({
      command: `git merge --no-ff ${branch} -m 'merge: ${taskId} by ${agent.id}'`,
      cwd: mainWorkspace,
      outputLimit: 3000,
    });
    if (!m.ok) {
      // 競合等。mainをマージ前の状態へ戻し、解決はエージェント側のworktreeでやってもらう
      await exec({ command: "git merge --abort", cwd: mainWorkspace, outputLimit: 1000 });
      return { ok: false, conflict: true, text: m.text };
    }
    return { ok: true, text: m.text };
  });
}
