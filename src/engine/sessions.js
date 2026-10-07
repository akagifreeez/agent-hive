// マルチセッション管理(v6.2): チャットの状態(state/配下のボードログ・会話メモリ・スレッドregistry)
// を名前付きスナップショットとして保存/復元する。復元はファイル差し替えなので、反映にはアプリ再起動が必要。
// タスク(tasks/)・成果物は対象外(プロジェクトの実体は残る)。
//
// イシュー#32対応:
// - state直下のサブディレクトリ(usage-trace/ 等)はディレクトリごとcpSync(recursive)で扱う
//   (旧実装はcopyFileSyncでディレクトリをコピーしようとしEPERMでok:false)。
// - 復元時は「復元対象ファイルの集合をスナップショットに一致」させる。旧セッションに無い
//   board-*.jsonl / mem-*.json が残ると別セッションの履歴が混入するため。
//   ただし対象外(監査・機微・sessions自身)は削除しない。
// - 保存は一時ディレクトリへ書き切ってからrename(原子的)。失敗時は一時を掃除するので
//   中途スナップショットがlistに現れて「完成済み」扱いされることがない。
import { existsSync, mkdirSync, readdirSync, copyFileSync, cpSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

// セッション対象外(state直下にあっても保存・復元・削除のいずれもしないもの):
// - sessions/: スナップショット置き場自身
// - audit*.jsonl: ツール実行の監査台帳(運用データ。時系列を壊さない)
// - models-*.oauth.json: OAuthトークンストア(リフレッシュトークンを含む機微情報)
function isExcluded(name) {
  return name === "sessions" || /^audit(-\d+)?\.jsonl$/.test(name) || /^models-.+\.oauth\.json$/.test(name);
}

function sessionDir(workspace, name) {
  return join(sessionsDir(workspace), name);
}

function sessionsDir(workspace) {
  return join(workspace, "state", "sessions");
}

function validName(name) {
  return NAME_RE.test(String(name ?? ""));
}

export function listSessions(workspace) {
  const d = sessionsDir(workspace);
  if (!existsSync(d)) return [];
  // ドット始まり(一時作業用 .*.tmp 等)は完成済みスナップショットとして数えない
  return readdirSync(d).filter((f) => !f.startsWith(".")).sort();
}

// 現在のstate(ボードログ/メモリ/registry)を state/sessions/<名前>/ へコピー
export function saveSession(workspace, name) {
  if (!validName(name)) return { ok: false, error: "セッション名は英数字と_-で40字以内" };
  const src = join(workspace, "state");
  const dst = join(sessionsDir(workspace), name);
  const tmp = join(sessionsDir(workspace), `.${name}.tmp`);
  try {
    if (!existsSync(src)) return { ok: false, error: "保存できる状態がまだありません" };
    mkdirSync(sessionsDir(workspace), { recursive: true });
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const f of readdirSync(src, { withFileTypes: true })) {
      if (isExcluded(f.name)) continue;
      if (f.isDirectory()) cpSync(join(src, f.name), join(tmp, f.name), { recursive: true });
      else copyFileSync(join(src, f.name), join(tmp, f.name));
    }
    // 書き切ってから差し替え(原子的)。失敗していたら中途スナップショットは残らない
    rmSync(dst, { recursive: true, force: true });
    renameSync(tmp, dst);
    return { ok: true, name };
  } catch (err) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 掃除失敗は無視 */ }
    return { ok: false, error: err.message };
  }
}

// 名前付きスナップショットを現在のstateへ復元。
// 対象ファイルの集合をスナップショットに一致させる(イシュー#32): スナップショットに無い
// 対象内の現stateファイル(board-*.jsonl / mem-*.json 等)は削除。対象外(監査・機微・sessions)
// は触らない。監査台帳が壊れにくいよう、削除はコピー全成功後の最終段で行う。
export function loadSession(workspace, name) {
  if (!validName(name)) return { ok: false, error: "セッション名は英数字と_-で40字以内" };
  const dstDir = sessionDir(workspace, name);
  if (!existsSync(dstDir)) return { ok: false, error: `セッション ${name} は存在しません` };
  const src = join(workspace, "state");
  mkdirSync(src, { recursive: true });
  try {
    const wanted = new Set(readdirSync(dstDir));
    for (const f of wanted) {
      copyFileSync(join(dstDir, f), join(src, f));
    }
    // 集合一致: スナップショットに無い対象内ファイルを削除(別セッションの履歴混入防止)
    for (const e of readdirSync(src, { withFileTypes: true })) {
      if (isExcluded(e.name) || wanted.has(e.name)) continue;
      if (e.isDirectory()) {
        if (/^(usage-trace|session-log)$/.test(e.name)) rmSync(join(src, e.name), { recursive: true, force: true });
      } else if (/^(board__.+|board-.+)\.jsonl$/.test(e.name) || /^mem-.+\.json$/.test(e.name) || e.name === "threads.json") {
        rmSync(join(src, e.name), { force: true });
      }
    }
    return { ok: true, name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
