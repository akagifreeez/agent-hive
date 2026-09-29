// クラッシュ復旧: 前回プロセス死で中断したworktree作業を次回起動時に拾う(#7)。
// 起動時setupWorktreesの「未コミット変更は保持」の後に呼ぶ前提で、
// ①既にコミット済みだがmainへ未マージのブランチ差分
// ②未コミット変更(保持されたままのもの)
// を検出してタスクを再起票する。ゾンビclaim回収(runner.js起動時)が担当を失った
// claimed を解放するのに対し、こちらは「仕事そのものが消えている」ケースを救う。
// 併せて、変更を持たない放棄ブランチ(worktrees/<agent>のみが残骸)の掃除も行う。
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./exec.js";

// パス比較用: git worktree listの絶対パスと、tmpdir由来で8.3短縮名を含みうるこちらのパスを、
// 「末尾2要素(親ディレクトリ名/エージェントid)」の一致で判定する(worktreeRoot/<id>構造が前提)。
/** @param {string} a @param {string} b */
function samePath(a, b) {
  const tail2 = (x) => {
    const parts = String(x).replaceAll("\\", "/").split("/").filter(Boolean);
    return parts.slice(-2).join("/").toLowerCase();
  };
  return tail2(a) === tail2(b);
}

/**
 * worktree(agent/<id>ブランチ)1件の検査結果。
 * @typedef {Object} RespawnFinding
 * @property {string} agentId worktreeディレクトリ名(=エージェントid)
 * @property {boolean} hasDiff main...agent/<id>に差分がある
 * @property {boolean} dirty 未コミット変更がある
 * @property {boolean} merged ブランチがmainに取り込み済み(祖先)
 * @property {string} head ブランチ先頭のSHA(短縮。取れない場合は空)
 * @property {number} files 変更ファイル数
 */

/**
 * 起動時の未完了作業を検出してタスクを再起票し、放棄ブランチを掃除する。
 * ワークスペースがgitリポジトリでない等の失敗は起動を止めない(結果にok:falseを返す)。
 * @param {Object} o
 * @param {string} o.mainWorkspace mainワークスペース(gitリポジトリ)
 * @param {string} o.worktreeRoot worktrees/<agentId> の親ディレクトリ
 * @param {import("./tasks.js").TaskBlackboard} o.tasks 再起票先タスクボード
 * @param {Object|null} [o.board] 告知先ボード(null可)
 * @param {Object|null} [o.bus] イベント発火先(null可)
 * @param {{cleanup?: boolean}} [o.opts] cleanup=trueで変更ゼロの放棄worktree/ブランチを自動削除(既定は提案のみ)
 * @returns {Promise<{ok: boolean, respawned: string[], swept: string[], suggested: string[], error?: string}>}
 */
export async function respawnUnfinishedWork({ mainWorkspace, worktreeRoot, tasks, board = null, bus = null, opts = {} }) {
  const cleanup = Boolean(opts.cleanup);
  /** @type {RespawnFinding[]} */
  const findings = [];
  const swept = [];
  const suggested = [];
  try {
    const dirs = existsSync(worktreeRoot)
      ? readdirSync(worktreeRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      : [];
    for (const agentId of dirs) {
      const path = realpathSync(resolve(join(worktreeRoot, agentId)));
      const f = /** @type {RespawnFinding} */ ({ agentId, hasDiff: false, dirty: false, merged: false, head: "", files: 0 });
      const run = async (cmd) => { const r = await runCommand({ command: cmd, cwd: mainWorkspace, outputLimit: 4000 }); return { ok: r.ok, text: r.text.split("\n").slice(1).join("\n") }; };
      // worktreeが実体として有効か(git worktree listに載るか)。ゴミdirは無視
      const branch = `agent/${agentId}`;
      const listed = await run(`git worktree list --porcelain`);
      if (!listed.ok || !listed.text.split("\n").some((l) => l.startsWith("worktree ") && samePath(l.slice("worktree ".length), path))) continue;
      // 未コミット変更
      const st = await run(`git -C '${path}' status --porcelain`);
      f.dirty = st.ok && st.text.split("\n").some((l) => l.trim());
      // main差分
      const df = await run(`git diff --name-only main...${branch}`);
      f.hasDiff = df.ok && df.text.split("\n").some((l) => l.trim());
      f.files = df.ok ? df.text.split("\n").map((l) => l.trim()).filter(Boolean).length : 0;
      // 既にmainへ取り込み済みか(祖先なら仕事は失われていない)
      const anc = await run(`git merge-base --is-ancestor ${branch} main && echo ANCESTOR`);
      f.merged = anc.ok && /ANCESTOR/.test(anc.text);
      const hd = await run(`git rev-parse --short ${branch}`);
      f.head = hd.ok ? (hd.text.split("\n")[1] ?? "").trim() : "";
      findings.push(f);
      const untouched = !f.hasDiff && !f.dirty;
      if (untouched) {
        // 変更ゼロ: 放棄ブランチ候補。cleanup=trueなら実掃除、falseなら提案だけ
        if (cleanup) {
          const rm = await run(`git worktree remove --force '${path}'`);
          if (rm.ok) {
            await run(`git branch -D ${branch} 2>/dev/null || true`);
            swept.push(agentId);
          } else {
            suggested.push(agentId);
          }
        } else {
          suggested.push(agentId);
        }
        continue;
      }
      if (f.merged && !f.dirty) continue; // 取り込み済みかつ未コミット無し: 再起票の必要なし
      // 再起票: idにHEAD短縮SHAを含めて冪等にする(同じ位置なら二重起票しない)
      const taskId = `respawn-${agentId}-${f.head || "dirty"}`.slice(0, 80);
      const body = [
        `[クラッシュ復旧] 前回プロセス死で中断した worktrees/${agentId}(ブランチ ${branch})の作業を再開してください。`,
        f.hasDiff ? `- mainからの差分: ${f.files}ファイル(コミット済み・未マージ)` : null,
        f.dirty ? `- 未コミット変更あり(worktree内に残置。内容を確認して確定してください)` : null,
        `- 作業場所: worktrees/${agentId}(あなたのworktreeとして再セットアップ済みの場合はそのまま続行)`,
        f.head ? `- ブランチ先頭: ${f.head}` : null,
        ``,
        `完了条件: 該当作業を確定(mainへマージ)するか、不要と判断して放棄を記録するか。`,
      ].filter((l) => l !== null).join("\n");
      const created = tasks.create({
        id: taskId,
        body,
        acceptance: "worktrees/" + agentId + " の作業がmainへ取り込まれるか、放棄判断が記録されること",
      });
      if (!created) f.hasDiff = false; // 既存タスクあり(冪等): 再通知対象から外す
    }
    if (board && (findings.some((x) => x.hasDiff || x.dirty) || swept.length || suggested.length)) {
      const lines = [`[起動時スキャン] worktree差分の検査結果:`];
      for (const f of findings) {
        if (f.hasDiff || f.dirty) lines.push(`- ${f.agentId}: 未完了の作業あり(差分${f.files}ファイル${f.dirty ? "+未コミット" : ""})→ タスク再起票(respawn-${f.agentId}-${f.head || "dirty"})`);
        else if (swept.includes(f.agentId)) lines.push(`- ${f.agentId}: 変更なし→ worktree/ブランチを掃除しました`);
        else if (suggested.includes(f.agentId)) lines.push(`- ${f.agentId}: 変更なし(放棄ブランチ候補。掃除は chat.respawn.cleanup=true で有効化できます)`);
      }
      board.post("system", lines.join("\n"));
    }
    bus?.emit("respawn.scanned", { respawned: findings.filter((x) => x.hasDiff || x.dirty).map((x) => x.agentId), swept, suggested });
    return { ok: true, respawned: findings.filter((x) => x.hasDiff || x.dirty).map((x) => x.agentId), swept, suggested };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    bus?.emit("scenario.warn", { message: `起動時スキャン失敗(起動は続行): ${error}` });
    return { ok: false, respawned: [], swept: [], suggested: [], error };
  }
}
