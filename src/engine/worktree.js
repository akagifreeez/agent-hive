// worktree隔離: エージェントごとに独立したチェックアウト(ブランチ agent/<id>)を
// 与え、finish_task時にmainへマージする。同一ファイルの同時変更にも耐える。
// マージはリポジトリ共有のindexを叩くため、直列化して index.lock 競合を防ぐ。
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./exec.js";
import { ensureMainCheckout } from "./branch-guard.js";

// マージ直列化: withMergeLock経由でのみ実行する。promiseチェーンのミューテックス。
// mergeAgentWorkは内部でこれを使い、tools.js/chat.js等の呼び出し元もこのロックを共有する。
let mergeChain = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withMergeLock(fn) {
  const p = /** @type {Promise<T>} */ (mergeChain.then(fn, fn));
  mergeChain = p.then(() => {}, () => {});
  return p;
}
/** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
function queueMerge(fn) {
  return withMergeLock(fn);
}

// 毎ランfreshに張り直す(前回のブランチ残骸を掃除)。ただし無音に壊してはいけないものは保持して
// onKeptで告知し、引き継ぎ判断を外に見せる: (1)worktree内の未コミット変更 (2)未マージのコミット
// (プロセス死で中断したコミット済み作業。イシュー#7: respawnスキャンより先に消さない)。
/** worktree内の未コミット変更(変更・untracked含む)の有無。setupWorktreesとcreateWorktreeで
 * 同一の判定を使う(イシュー#23: 直呼び経路でもdirtyを見逃さない)。
 * @returns {Promise<string|null>} dirtyならstatus出力(詳細)、cleanならnull */
export async function dirtyWorktreeDetail({ path, exec = runCommand }) {
  const st = await exec({ command: "git status --porcelain", cwd: path, outputLimit: 2000 });
  if (!st.ok) return null; // 判定不能はclean扱いで続行(既存契約)
  return st.text.split("\n").slice(1).some((l) => l.trim()) ? st.text.slice(0, 800) : null;
}

export async function setupWorktrees({ mainWorkspace, worktreeRoot, agents, exec = runCommand, onKept = null }) {
  const paths = {};
  for (const agent of agents) {
    const path = resolve(join(worktreeRoot, agent.id));
    if (existsSync(path)) {
      const dirtyDetail = await dirtyWorktreeDetail({ path, exec });
      if (dirtyDetail) {
        paths[agent.id] = path;
        onKept?.({ agentId: agent.id, path, detail: dirtyDetail });
        continue;
      }
      // dirty無しでも未マージのコミットが残っていれば保持する(respawnスキャンの検出対象)
      const unmerged = await hasUnmergedWork({ mainWorkspace, agentId: agent.id, exec });
      if (unmerged) {
        paths[agent.id] = path;
        onKept?.({ agentId: agent.id, path, detail: "未マージコミットを保持" });
        continue;
      }
    }
    paths[agent.id] = await createWorktree({ mainWorkspace, worktreeRoot, agentId: agent.id, exec });
  }
  return paths;
}

/** エージェントブランチに「mainへ未マージのコミット」があるか。ブランチやworktreeが
 * 無い/判定に失敗した場合はfalse(=作り直してよい)。 */
export async function hasUnmergedWork({ mainWorkspace, agentId, exec = runCommand }) {
  const branch = `agent/${agentId}`;
  const rev = await exec({ command: `git rev-parse --verify ${branch}`, cwd: mainWorkspace, outputLimit: 200 });
  if (!rev.ok) return false; // ブランチ無し
  const anc = await exec({ command: `git merge-base --is-ancestor ${branch} main`, cwd: mainWorkspace, outputLimit: 200 });
  if (anc.ok) return false; // mainに含まれている(マージ済み) → 作り直してよい
  const log = await exec({ command: `git log main..${branch} --oneline`, cwd: mainWorkspace, outputLimit: 2000 });
  return Boolean(log.ok && log.text.split("\n").slice(1).some((l) => l.trim())); // 未マージコミットあり
}

// 1エージェント分のworktreeを動的に作る(v5: スポーンされるエージェント向け)
export async function createWorktree({ mainWorkspace, worktreeRoot, agentId, exec = runCommand, onKept = null }) {
  const path = resolve(join(worktreeRoot, agentId));
  const branch = `agent/${agentId}`;
  if (existsSync(path)) {
    // 二重防御その1: 未マージコミット付きworktreeは壊さない(イシュー#7)
    if (await hasUnmergedWork({ mainWorkspace, agentId, exec })) {
      onKept?.({ agentId, path, detail: "未マージコミットを保持" });
      return path;
    }
    // 二重防御その2(イシュー#23): 未コミットファイル(変更・untracked)があるworktreeを
    // remove --forceで消さない。stash(push -u)で退避してから再作成する。退避失敗時は
    // 成果喪失を避けるため再作成を拒否して例外にする(呼び出し側spawn.jsはerrorへ変換)。
    const dirty = await dirtyWorktreeDetail({ path, exec });
    if (dirty) {
      const stashMsg = `hive-pre-recreate-${agentId}`;
      const st = await exec({ command: `git stash push -u -m "${stashMsg}"`, cwd: path, outputLimit: 2000 });
      const verify = await exec({ command: "git status --porcelain", cwd: path, outputLimit: 2000 });
      const stillDirty = verify.ok && verify.text.split("\n").slice(1).some((l) => l.trim());
      if (!st.ok || stillDirty) {
        throw new Error(`worktree再作成を拒否(${agentId}): 未コミット変更の退避に失敗。手動確認が必要です。status: ${(stillDirty ? verify.text : st.text).slice(0, 200)}`);
      }
      onKept?.({ agentId, path, detail: `未コミット変更をstash退避して再作成(${stashMsg})` });
    }
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

/**
 * エージェントのworktree作業をmainへ取り込む(finish_taskとラウンド末自動マージの共通経路)。
 * 取り込みはwithMergeLockで直列化される。
 * @typedef {Object} MergeResult
 * @property {boolean} ok
 * @property {boolean} [merged] 新たに取り込んだか
 * @property {boolean} [conflict] 競合(自動再試行でも解消できなかった)
 * @property {string} text
 * @property {string} [stat] git diff --statの要約
 * @property {string} [patch] 差分本文(上限付き)
 * @property {string} [summary]
 * @property {boolean} [autoMerged] 競合からの自動再マージで成功した
 * @property {boolean} [marker] 競合マーカーガードに拒否された
 */
/**
 * @param {Object} o
 * @param {string} o.mainWorkspace
 * @param {string} o.worktreePath
 * @param {{id: string, displayName?: string}} o.agent
 * @param {string} o.taskId
 * @param {Function} [o.exec]
 * @returns {Promise<MergeResult>}
 */
export function mergeAgentWork({ mainWorkspace, worktreePath, agent, taskId, exec = runCommand }) {
  // cwd省略はプロセスの現在のフォルダーを使うため、git add/commit前に必ず遮断する。
  if (!mainWorkspace?.trim() || !worktreePath?.trim()) {
    return Promise.resolve({ ok: false, text: "マージ先またはworktreeの作業フォルダーが未設定です。マージを中止しました。" });
  }
  const branch = `agent/${agent.id}`;
  return queueMerge(async () => {
    // -0.5) ブランチ漂流ガード: mainワークスペースのチェックアウトがagent/<id>等へ漂流していたら
    //    安全にmainへ復帰してからマージする(2026-10-07朝の本番実害: 漂流+中断マージで
    //    マージがagentブランチへ滞留し、起動不能に至った)。復帰できないときは中止して理由を返す。
    const guard = await ensureMainCheckout({ mainWorkspace, exec });
    if (!guard.ok) return { ok: false, drift: true, text: guard.reason };
    // 0) 競合マーカーガード: マーカー入りのmainをマージするとmain全体が構文破損する。
    //    main側に既にマーカーがある場合はマージ自体を中止する(r7で実際に発生)
    const mainMarkers = await exec({
      command: `git grep -l -E "^(<{7}|>{7})" -- . ":(exclude)worktrees/**" ":(exclude)state/**" ":(exclude)dist/**" ":(exclude)node_modules/**"`,
      cwd: mainWorkspace,
      outputLimit: 2000,
    });
    if (mainMarkers.ok && mainMarkers.text.trim()) {
      const files = mainMarkers.text.trim().split("\n").map((f) => f.trim()).join(", ");
      return { ok: false, marker: true, text: `mainに競合マーカーが残っています(${files})。マージを中止しました。先にmain側のマーカーを解消してください。` };
    }
<<<<<<< HEAD
    // 1) worktree側の未コミット変更を確定(変更がなければno-op)。ステップを分解して
    // コミット失敗(pre-commitフック等)を見える化する(イシュー#28: 空振りコミットの成功扱い防止)
    const addStep = await exec({ command: "git add -A", cwd: worktreePath, outputLimit: 2000 });
    if (!addStep.ok) {
      return { ok: false, text: "ステージ(git add)に失敗しました: " + addStep.text.slice(0, 300) };
    }
    const staged = await exec({ command: "git diff --cached --quiet", cwd: worktreePath, outputLimit: 500 });
    if (!staged.ok) {
      const commitStep = await exec({
        command: "git -c user.name=" + agent.id + " -c user.email=" + agent.id + "@hive.local commit -m 'wip: " + taskId + "'",
        cwd: worktreePath,
        outputLimit: 2000,
      });
      if (!commitStep.ok) {
        return { ok: false, text: "コミットに失敗しました(pre-commitフック等): " + commitStep.text.slice(0, 300) };
=======
    // 1) worktree側の未コミット変更を確定(変更がなければno-op)。
    //    add/commitを個別に検査する(イシュー#28: pre-commitフック等でコミットが空振りしても
    //    従来は ok:true 扱いになり、成果がmainに入らないまま成功扱いになっていた)。
    const add = await exec({ command: "git add -A", cwd: worktreePath, outputLimit: 2000 });
    if (!add.ok) {
      return { ok: false, text: "ステージ(git add)に失敗しました: " + add.text.slice(0, 400) };
    }
    const staged = await exec({ command: "git diff --cached --quiet", cwd: worktreePath, outputLimit: 2000 });
    let commit = { ok: true, text: "" };
    if (!staged.ok) {
      // ステージ差分あり=コミットを試みる。ここで失敗したら成果は確定できていない
      commit = await exec({
        command: `git -c user.name=${agent.id} -c user.email=${agent.id}@hive.local commit -m 'wip: ${taskId}'`,
        cwd: worktreePath,
        outputLimit: 2000,
      });
      if (!commit.ok) {
        return { ok: false, text: "コミットに失敗(pre-commitフック等): " + commit.text.slice(0, 400) + " 変更を確定できるようにしてから再度 finish_task してください。" };
>>>>>>> main
      }
    }
    // 1.5) ブランチ側ガード: このマージで運ばれるファイルにマーカーが入っていれば拒否し、
    //      作業者へ返送する(マーカー入りの確定をmainに作らない)
    const dirty = await exec({ command: `git diff --name-only main...agent/${agent.id}`, cwd: mainWorkspace, outputLimit: 4000 });
    const changed = dirty.ok ? dirty.text.split("\n").map((f) => f.trim()).filter(Boolean) : [];
    if (changed.length) {
      const q = changed.map((f) => `"${f}"`).join(" ");
      const wtMarkers = await exec({
        command: `git grep -l -E "^(<{7}|>{7})" agent/${agent.id} -- ${q}`,
        cwd: mainWorkspace,
        outputLimit: 2000,
      });
      if (wtMarkers.ok && wtMarkers.text.trim()) {
        const files = wtMarkers.text.trim().split("\n").map((f) => f.replace(/^[^:]+:/, "").trim()).join(", ");
        return { ok: false, marker: true, text: `worktree側の変更に競合マーカーが含まれています(${files})。マージを中止しました。worktree内でマーカーを削除してコミットしてから再度 finish_task してください。` };
      }
    }
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
