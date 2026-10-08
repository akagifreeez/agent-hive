// プロセス死からの自動再起動ウォッチドッグ(long-run-resilience)。
// 背景: respawn復旧(respawn.js)は「次回起動時」の掃除だけで、プロセスが死んでいる間は
// 誰にも起こされない。監視ポート(7791)は「落ちたと分かる」仕組みで再起動はしない。
// このモジュールは 1分間隔の外部トリガ(Windowsタスクスケジューラ等・scripts/watchdog.mjs)
// から呼ばれ、「ダウン AND ユーザーがONにしている(marker有り)」ときだけ hive を起こす。
//
// 設計:
// - 疎通は node:http のみ(依存ゼロ)。UIポート(既定7789)の /api/state を見る。
// - marker(state/watchdog-on)が無ければ何もしない(ユーザーが意図的に止めている時は起こさない)。
// - 起動は spawnFn として差し替え可能(テスト固定・scripts/watchdog.mjsからはdetach spawn)。
// - 再起動の事実は state/watchdog.log へ1行JSONで残す(監査可能にする)。
// - schtasksへの実登録はユーザーレベル範囲。本モジュールは登録しない(README手順を主務とする)。
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/** markerとログの置き場(state/)。workspace直下。 */
function stateDir(workspace) {
  return join(workspace ?? process.cwd(), "state");
}

/**
 * 自動再起動が有効か(state/watchdog-on の存在)。
 * @param {string} [workspace] 既定は process.cwd()
 * @returns {boolean}
 */
export function watchdogEnabled(workspace) {
  return existsSync(join(stateDir(workspace), "watchdog-on"));
}

/**
 * marker切替(ON/OFF)。ディレクトリが無ければ作る。
 * @param {boolean} on
 * @param {string} [workspace]
 * @returns {{ok: boolean, enabled: boolean}}
 */
export function setWatchdog(on, workspace) {
  const dir = stateDir(workspace);
  const marker = join(dir, "watchdog-on");
  mkdirSync(dir, { recursive: true });
  if (on) writeFileSync(marker, String(Date.now()));
  else { try { unlinkSync(marker); } catch { /* 無ければそのまま */ } }
  return { ok: true, enabled: on };
}

/**
 * 疎通確認(依存ゼロ: node:http/https)。
 * @param {string} url 完全URL
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} 2xx/3xxが返ればup
 */
export async function probe(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = (url.startsWith("https:") ? httpsRequest : httpRequest)(url, { timeout: timeoutMs }, (res) => {
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400;
        res.resume();
        done(ok);
      });
    } catch {
      done(false);
      return;
    }
    req.on("timeout", () => { req.destroy(); done(false); });
    req.on("error", () => done(false));
    req.end();
  });
}

/**
 * 1回の監視サイクル。疎通→marker判定→(必要なら)起動→ログ。
 * @param {Object} o
 * @param {string} o.url 疎通先(既定は HIVE_UI_PORT の /api/state。scripts/watchdog.mjsが解決して渡す)
 * @param {string} [o.workspace] state/の基準ディレクトリ
 * @param {string} [o.markerPath] markerパス(テスト用上書き。既定はstate/watchdog-on)
 * @param {string} [o.logPath] ログパス(テスト用上書き。既定はstate/watchdog.log)
 * @param {((cmd: string, args: string[], opts: {detached: boolean, stdio: string[], windowsHide: boolean}) => {pid?: number})|null} [o.spawnFn]
 *        起動処理(差し替え可能)。nullでmarker判定のみ(起動しない)。既定の実装はscripts/watchdog.mjs側
 * @param {string} [o.startCmd] 起動コマンド(既定 process.execPath)
 * @param {string[]} [o.startArgs] 起動引数(既定 ["src/index.js","--chat"])
 * @returns {Promise<{action: "respawn"|"none", reason: string, pid?: number}>}
 */
export async function checkOnce(o) {
  const workspace = o.workspace ?? process.cwd();
  const markerPath = o.markerPath ?? join(stateDir(workspace), "watchdog-on");
  const logPath = o.logPath ?? join(stateDir(workspace), "watchdog.log");
  const up = await probe(o.url);
  if (up) return { action: "none", reason: "up" };
  if (!existsSync(markerPath)) return { action: "none", reason: "no-marker" };
  // 起動(既定: node src/index.js --chat をデタッチ)
  const cmd = o.startCmd ?? process.execPath;
  const args = o.startArgs ?? ["src/index.js", "--chat"];
  const spawnOpts = { detached: true, stdio: "ignore", windowsHide: true };
  let pid = null;
  if (typeof o.spawnFn === "function") {
    const r = o.spawnFn(cmd, args, spawnOpts);
    pid = r?.pid ?? null;
  }
  // 再起動ログ(必ず残す。ログ失敗で監視を止めない)
  try {
    mkdirSync(logPath.includes("watchdog.log") ? logPath.slice(0, logPath.lastIndexOf("watchdog.log") - 1) : stateDir(workspace), { recursive: true });
    appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), action: "respawn", url: o.url, cmd, pid }) + "\n");
  } catch { /* ログ失敗は無視(監視を止めない) */ }
  return { action: "respawn", reason: "down+marker", pid: pid ?? undefined };
}
