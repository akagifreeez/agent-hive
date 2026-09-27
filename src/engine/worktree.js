// worktree隔離: エージェントごとに独立したチェックアウト(ブランチ agent/<id>)を
// 与え、finish_task時にmainへマージする。同一ファイルの同時変更にも耐える。
// マージはリポジトリ共有のindexを叩くため、直列化して index.lock 競合を防ぐ。
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./exec.js";

// マージ直列化: withMergeLock経由でのみ実行する。promiseチェーンのミューテックス。
// mergeAgentWorkは内部でこれを使い、tools.js/chat.js等の呼び出し元もこのロックを共有する。
let mergeChain = Promise.resolve();
export function withMergeLock(fn) {
  const p = mergeChain.then(fn, fn);
  mergeChain = p.then(() => {}, () => {});
  return p;
}
function queueMerge(fn) {
  return withMergeLock(fn);
}

// 毎ランfreshに張り直す(前回のブランチ残骸を掃除)。ただしworktree内に未コミット変更が
// ある場合は無音に壊さない——保持してonKeptで告知し、引き継ぎ判断を外に見せる。
export async function setupWorktrees({ mainWorkspace, worktreeRoot, agents, exec = runCommand, onKept = null }) {
  const paths = {};
  for (const agent of agents) {
    const path = resolve(join(worktreeRoot, agent.id));
    if (existsSync(path)) {
      const st = await exec({ command: "git status --porcelain", cwd: path, outputLimit: 2000 });
      const dirty = st.ok && st.text.split("\n").slice(1).some((l) => l.trim());
      if (dirty) {
        paths[agent.id] = path;
        onKept?.({ agentId: agent.id, path, detail: st.text.slice(0, 800) });
        continue;
      }
    }
    paths[agent.id] = await createWorktree({ mainWorkspace, worktreeRoot, agentId: agent.id, exec });
  }
  return paths;
}

// 1エージェント分のworktreeを動的に作る(v5: スポーンされるエージェント向け)
export async function createWorktree({ mainWorkspace, worktreeRoot, agentId, exec = runCommand }) {
  const path = resolve(join(worktreeRoot, agentId));
  const branch = `agent/${agentId}`;
  if (existsSync(path)) {
    await exec({ command: `git worktree remove --force '${path}'`, cwd: mainWorkspace, outputLimit: 1000 });
  }
  await exec({ command: `git branch -D ${branch} 2>/dev/null || true`, cwd: mainWorkspace, outputLimit: 1000 });
  const r = await exec({ command: `git worktree add -b ${branch} '${path}' main`, cwd: mainWorkspace, outputLimit: 2000 });
  if (!r.ok) throw new Error(`worktree作成失敗(${agentId}): ${r.text.slice(0, 300)}`);
  return path;
}

// マージ差分の要約(--statの出力から「3ファイル +42 -3」形式の短文を作る)
export function statSummary(statText) {
  const m = (statText ?? "").match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  if (!m) return "";
  const parts = [`${m[1]}ファイル`];
  if (m[2]) parts.push(`+${m[2]}`);
  if (m[3]) parts.push(`-${m[3]}`);
  return parts.join(" ");
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
    // 2) mainのマージ前位置を控える(マージ後のdiffはここからの差分)
    const pre = await exec({ command: "git rev-parse main", cwd: mainWorkspace, outputLimit: 200 });
    const preSha = pre.ok ? (pre.text.split("\n")[1] ?? "").trim() : "";
    // 3) mainへマージ
    const m = await exec({
      command: `git merge --no-ff ${branch} -m 'merge: ${taskId} by ${agent.id}'`,
      cwd: mainWorkspace,
      outputLimit: 3000,
    });
    if (!m.ok) {
      // 競合等。mainをマージ前の状態へ戻す
      await exec({ command: "git merge --abort", cwd: mainWorkspace, outputLimit: 1000 });
      // 競合自動取込: ワーカーのworktree内で git merge main を1回だけ試す。
      // クリーンに通ればそのまま再マージ。競合マーカーが残る形なら現行どおりconflictで返す。
      const auto = await exec({
        command: `git add -A && git -c user.name=${agent.id} -c user.email=${agent.id}@hive.local commit -m 'wip: ${taskId}' || true`,
        cwd: worktreePath,
        outputLimit: 2000,
      });
      const mm = await exec({ command: "git merge main -m 'merge main (auto-import before re-merge)'", cwd: worktreePath, outputLimit: 3000 });
      if (mm.ok) {
        const retry = await exec({
          command: `git merge --no-ff ${branch} -m 'merge: ${taskId} by ${agent.id}'`,
          cwd: mainWorkspace,
          outputLimit: 3000,
        });
        if (retry.ok) {
          const s = await exec({ command: `git diff --stat ${preSha} main`, cwd: mainWorkspace, outputLimit: 4000 });
          const p = await exec({ command: `git diff ${preSha} main`, cwd: mainWorkspace, outputLimit: 60000 });
          const stat = s.ok ? s.text.split("\n").slice(1).join("\n").trim() : "";
          const patch = p.ok ? p.text.split("\n").slice(1).join("\n") : "";
          return { ok: true, merged: true, text: retry.text, stat, patch, summary: statSummary(stat), autoMerged: true };
        }
        await exec({ command: "git merge --abort", cwd: mainWorkspace, outputLimit: 1000 });
      }
      // 自動取込失敗: worktree側のマージ状態を戻してからconflictで返す(競合マーカーは残す)
      await exec({ command: "git merge --abort", cwd: worktreePath, outputLimit: 1000 });
      return { ok: false, conflict: true, text: `${m.text}\n\nmainは取り込み済み。あなたのworktree内で \`git merge main\` を実行し、競合ファイルを解消してから再度 finish_task してください。` };
    }
    if (/already up to date/i.test(m.text)) return { ok: true, merged: false, text: m.text };
    // 4) 差分(--stat要約+patch。patchは出力上限で丸められる)
    let stat = "";
    let patch = "";
    if (preSha) {
      const s = await exec({ command: `git diff --stat ${preSha} main`, cwd: mainWorkspace, outputLimit: 4000 });
      const p = await exec({ command: `git diff ${preSha} main`, cwd: mainWorkspace, outputLimit: 60000 });
      stat = s.ok ? s.text.split("\n").slice(1).join("\n").trim() : "";
      patch = p.ok ? p.text.split("\n").slice(1).join("\n") : "";
    }
    return { ok: true, merged: true, text: m.text, stat, patch, summary: statSummary(stat) };
  });
}
