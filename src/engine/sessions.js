// マルチセッション管理(v1): チャットの状態(state/配下のボードログ・会話メモリ・スレッドregistry)
// を名前付きスナップショットとして保存/復元する。復元はファイル差し替えなので、反映にはアプリ再起動が必要。
// タスク(tasks/)・成果物は対象外(プロジェクトの実体は残る)。
import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

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
  return readdirSync(d).sort();
}

// 現在のstate(ボードログ/メモリ/registry)を state/sessions/<名前>/ へコピー
export function saveSession(workspace, name) {
  if (!validName(name)) return { ok: false, error: "セッション名は英数字と_-で40字以内" };
  const src = join(workspace, "state");
  const dst = join(sessionsDir(workspace), name);
  try {
    mkdirSync(dst, { recursive: true });
    if (!existsSync(src)) return { ok: false, error: "保存できる状態がまだありません" };
    for (const f of readdirSync(src)) {
      if (f === "sessions") continue;
      copyFileSync(join(src, f), join(dst, f));
    }
    return { ok: true, name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 名前付きスナップショットを現在のstateへ復元(既存のstate配下ファイルは上書き)
export function loadSession(workspace, name) {
  if (!validName(name)) return { ok: false, error: "セッション名は英数字と_-で40字以内" };
  const dstDir = sessionDir(workspace, name);
  if (!existsSync(dstDir)) return { ok: false, error: `セッション ${name} は存在しません` };
  const src = join(workspace, "state");
  mkdirSync(src, { recursive: true });
  try {
    for (const f of readdirSync(dstDir)) {
      copyFileSync(join(dstDir, f), join(src, f));
    }
    return { ok: true, name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
