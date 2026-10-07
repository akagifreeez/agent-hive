// mainブランチ漂流ガード(self-improve-lab-lessons): 本番実害(2026-10-07朝)の再発防止。
// mainワークスペースのチェックアウトがagent/<id>等へ漂流すると、finish_task/ラウンド末の
// mergeAgentWorkが「mainのコミット位置」を書き換えるどころかagentブランチ自体へコミットを
// 積み(47コミット滞留の実害)、更に中断マージ(MERGE_HEAD+競合マーカー)が残って起動不能に至る。
// 対策は2層:
//   (1) mergeAgentWorkのマージ直前チェック(ensureMainCheckout): 漂流を検出したら安全にmainへ
//       復帰してからマージする。復帰できないときはマージを中止して理由を返す(沈黙しない)。
//   (2) 起動時チェック(runner.jsからensureMainCheckoutを呼び、逸脱をボードへ警告)。
import { runCommand } from "./exec.js";

/** mainワークスペース(gitリポジトリ)のチェックアウト状態を検査し、main以外に漂流していたら
 * 安全にmainへ復帰させる。中断マージ(MERGE_HEAD残存)があれば先にmerge --abortする。
 *
 * 復帰の安全条件(この順で判定):
 *   1. MERGE_HEAD がある(中断マージ) → 未コミットのマージ状態なので merge --abort で戻す
 *   2. 未コミット変更がある → 勝手に捨てない。復帰せず status を添えて中止(手動確認)
 *   3. クリーン → checkout main(復帰)。mainが無いリポジトリ等は何もしない
 *
 * 判定不能(git不在等)は既存契約どおり起動/マージを止めない。
 * @param {Object} o
 * @param {string} o.mainWorkspace mainワークスペース(gitリポジトリ)
 * @param {Function} [o.exec] コマンド実行(既定runCommand。テストで差し替え)
 * @returns {Promise<{ok: boolean, branch?: string, abort?: boolean, reason?: string}>}
 */
export async function ensureMainCheckout({ mainWorkspace, exec = runCommand }) {
  const out = { ok: true };
  const br = await exec({ command: "git rev-parse --abbrev-ref HEAD", cwd: mainWorkspace, outputLimit: 200 });
  if (!br.ok) {
    // gitリポジトリでない/判定不能 → 何もしない(既存契約: 起動・マージを止めない)
    out.branch = "";
    return out;
  }
  const branch = (br.text.split("\n")[1] ?? "").trim();
  out.branch = branch;
  if (!branch || branch === "main") return out; // 正常
  // 漂流を検出: MERGE_HEAD残存(中断マージ)なら最優先でabort(実害経路)。abortは作業を消さない
  // (マージエントリを解消して競合前へ戻す)が、確定していない競合解消を持てるため、
  // 未コミット変更が残る形になる。その場合は次のdirty判定で中止になる(沈黙しない)。
  const mh = await exec({ command: "git rev-parse -q --verify MERGE_HEAD", cwd: mainWorkspace, outputLimit: 200 });
  if (mh.ok && (mh.text.split("\n")[1] ?? "").trim()) {
    const ab = await exec({ command: "git merge --abort", cwd: mainWorkspace, outputLimit: 1000 });
    if (!ab.ok) {
      out.ok = false;
      out.reason = `mainワークスペースがブランチ ${branch} に漂流し、中断マージの解消(merge --abort)に失敗しました。手動確認が必要です: ${ab.text.slice(0, 200)}`;
      return out;
    }
    out.abort = true;
  }
  // 未コミット変更は勝手に捨てない(成果喪失の危険)。クリーンなときだけ復帰する
  const st = await exec({ command: "git status --porcelain", cwd: mainWorkspace, outputLimit: 2000 });
  const dirty = st.ok && st.text.split("\n").slice(1).some((l) => l.trim());
  if (dirty) {
    out.ok = false;
    out.reason = `mainワークスペースがブランチ ${branch} に漂流しています。未コミット変更があるため自動復帰しません(勝手に消さないため)。手動で確定/退避して main へ checkout してください。status: ${st.text.slice(1, 600)}`;
    return out;
  }
  const co = await exec({ command: "git checkout main", cwd: mainWorkspace, outputLimit: 1000 });
  if (!co.ok) {
    out.ok = false;
    out.reason = `mainワークスペースがブランチ ${branch} に漂流しており、mainへの復帰に失敗しました: ${co.text.slice(0, 300)}`;
    return out;
  }
  // out.branchには検出した漂流先を保持する(復帰成功でもmainで上書きしない)。
  // runner側は branch !== "main" で逸脱検出して警告するため、復帰成功時にここで書き換えると
  // 逸脱警告が消失する(初回実装で捕捉漏れ)。復帰済みはrestoredで示す。
  out.restored = true;
  return out;
}
