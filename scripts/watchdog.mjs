#!/usr/bin/env node
// プロセス死からの自動再起動ウォッチドッグ(1分間隔の外部トリガから呼ぶ想定)。
// 使い方:
//   node scripts/watchdog.mjs            1回チェック(ダウン+marker有りなら再起動)
//   node scripts/watchdog.mjs --once     同上(明示)
//   node scripts/watchdog.mjs --loop     常駐(60秒間隔でチェック)
//   node scripts/watchdog.mjs on|off     自動再起動のON/OFF(state/watchdog-on marker)
//
// 疎通先はUIポート(HIVE_UI_PORT環境変数、既定7789)の /api/state。
// ダウン AND state/watchdog-on 有り のときだけ node src/index.js --chat をデタッチ起動する。
//
// Windowsタスクスジューラへの登録(ユーザーレベル・README手順):
//   schtasks /create /tn "agent-hive-watchdog" /tr "node <絶対パス>\scripts\watchdog.mjs" /sc minute /mo 1 /f
// 解除:
//   schtasks /delete /tn "agent-hive-watchdog" /f
import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOnce, setWatchdog, watchdogEnabled } from "../src/engine/watchdog.js";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..");
const uiPort = Number(process.env.HIVE_UI_PORT) || 7789;
const url = `http://127.0.0.1:${uiPort}/api/state`;

const arg = process.argv[2] ?? "";
if (arg === "on" || arg === "off") {
  const r = setWatchdog(arg === "on", workspace);
  console.log(`watchdog: 自動再起動を ${r.enabled ? "ON" : "OFF"} にしました(state/watchdog-on ${r.enabled ? "作成" : "削除"})`);
  process.exit(0);
}
if (arg === "status") {
  console.log(`watchdog: ${watchdogEnabled(workspace) ? "ON" : "OFF"} (marker: state/watchdog-on)`);
  process.exit(0);
}

const isLoop = arg === "--loop";
const runOnce = async () => {
  const r = await checkOnce({
    url,
    workspace,
    spawnFn: (cmd, args, opts) => {
      const child = spawn(cmd, args, { ...opts, cwd: workspace });
      child.unref(); // デタッチ(監視側の寿命に紐付けない)
      return { pid: child.pid };
    },
  });
  if (r.action === "respawn") {
    console.log(`[${new Date().toISOString()}] hiveがダウンしていたため再起動しました(pid=${r.pid}) → state/watchdog.log`);
  }
  return r;
};

if (isLoop) {
  // 常駐モード: 60秒間隔。タスクスジューラが使えない環境での代替(手動起動)。
  console.log(`watchdog: ループ開始(${url} を60秒間隔で監視)`);
  await runOnce();
  setInterval(() => { runOnce().catch(() => {}); }, 60_000);
} else {
  const r = await runOnce();
  process.exit(0); // ダウンでも監視スクリプト自体は成功扱い(タスクスジューラのエラー通知を避ける)
}
