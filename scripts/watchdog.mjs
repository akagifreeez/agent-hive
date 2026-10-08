#!/usr/bin/env node
// プロセス死からの自動再起動ウォッチドッグ(long-run-resilience)。
//
// 使い方(手動):
//   node scripts/watchdog.mjs --once     1回だけ判定して終了(テスト/タスクスケジューラ両用)
//   node scripts/watchdog.mjs --loop     常駐して60秒間隔で判定(Ctrl+Cまで)
//
// Windowsタスクスケジューラ登録(ユーザーレベル・管理者不要。README「自動再起動ウォッチドッグ」参照):
//   schtasks /create /tn "AgentHiveWatchdog" /tr "node <絶対パス>scripts\watchdog.mjs --once" /sc minute /mo 1 /f
//
// 挙動:
//   - UIポート(既定7789/HIVE_UI_PORT)へ疎通 → 稼働中なら何もしない
//   - ダウン AND marker(state/watchdog-on)有り → `node src/index.js --chat` をデタッチ起動し、
//     state/watchdog.log へ記録
//   - marker無し → 何もしない(ユーザーが意図的に止めているケースを起こさない)
//
// 疎通先の差し替え: probeUrl env(例: HIVE_WATCHDOG_URL=http://localhost:7789/api/state)。
// テストでは判定部(startIfNeeded)をモジュールから呼び出して固定する。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { get } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const STATE_DIR = process.env.HIVE_DATA ? resolve(process.env.HIVE_DATA, "state") : join(ROOT, "state");
const MARKER = join(STATE_DIR, "watchdog-on");
const LOG = join(STATE_DIR, "watchdog.log");
const PORT = Number(process.env.HIVE_UI_PORT) || 7789;
const PROBE_URL = process.env.HIVE_WATCHDOG_URL || `http://localhost:${PORT}/api/state`;
const INTERVAL_MS = Number(process.env.HIVE_WATCHDOG_INTERVAL_MS) || 60_000;
const SPAWN_CMD = process.env.HIVE_WATCHDOG_SPAWN || `node ${JSON.stringify(join(ROOT, "src", "index.js"))} --chat`;

function logLine(text) {
  const ts = new Date().toISOString();
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(LOG, `[${ts}] ${text}\n`);
  } catch {}
}

/** 疎通確認。稼働中=true。5秒で諦める(ウォッチドッグは中断が正義) */
export function probeAlive(url = PROBE_URL, timeoutMs = 5000) {
  return new Promise((resolveOk) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolveOk(v); } };
    try {
      const req = get(url, { timeout: timeoutMs }, (r) => { r.resume(); finish(true); });
      req.on("error", () => finish(false));
      req.on("timeout", () => { req.destroy(); finish(false); });
    } catch { finish(false); }
  });
}

/** marker(state/watchdog-on)を作る。戻り値: 切替後の状態 */
export function enableWatchdog() {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(MARKER, new Date().toISOString() + "\n");
  return true;
}

export function disableWatchdog() {
  try { unlinkSync(MARKER); } catch {}
  return false;
}

export function isWatchdogEnabled() {
  return existsSync(MARKER);
}

/**
 * 判定の本体(テストから直接呼べるようprobeとspawnerを差し替え可能にした)
 * @param {{probe?: () => Promise<boolean>, spawn?: (cmd: string) => void, enabled?: () => boolean, note?: string}} [opts]
 * @returns {Promise<"up"|"no-marker"|"started">} 何をしたか
 */
export async function startIfNeeded(opts = {}) {
  const probe = opts.probe ?? (() => probeAlive());
  const doSpawn = opts.spawn ?? ((cmd) => {
    // デタッチ起動: 親(watchdog)が死んでも子は生き続ける。Windowsはshell経由でなくてもdetachedでOK
    const parts = cmd.split(" ");
    const child = spawn(parts[0], parts.slice(1), {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.unref();
  });
  const enabled = opts.enabled ?? isWatchdogEnabled;
  if (await probe()) return "up";
  if (!enabled()) return "no-marker";
  logLine(`down & marker有り → 再起動: ${SPAWN_CMD}`);
  doSpawn(SPAWN_CMD);
  return "started";
}

// CLI本体
const arg = process.argv[2] ?? "--once";
if (arg === "--once") {
  const r = await startIfNeeded();
  if (r === "started") console.log("agent-hiveを再起動しました(watchdog.logを参照)");
  process.exit(0);
} else if (arg === "--loop") {
  console.log(`watchdog常駐開始(${INTERVAL_MS}ms間隔, marker=${MARKER})`);
  // ループ開始時にも一度判定(起動直後の取りこぼしを防ぐ)
  await startIfNeeded();
  setInterval(() => { void startIfNeeded(); }, INTERVAL_MS);
} else {
  console.error("使い方: node scripts/watchdog.mjs --once | --loop");
  process.exit(2);
}
