// 実走E2E: 一時ワークスペース+実APIでchatモード(v6スタック全体)を1回走らせる。
// 使い方: node scripts/e2e-chat.mjs [タスク文]
// 検証するもの: リーダー計画→open_thread→3ワーカー並行→タスク完遂→mainマージ→
//              ストリーミングdelta→state/永続化。完了後サマリを出力する。
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { runChat } from "../src/runner.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";
import { wireConsoleLog } from "../src/log.js";

const task = process.argv[2] ?? "todoリストを管理するnodeスクリプト(todo.js、コマンドは add / list / done)を作り、node:testで動作確認まで済ませて。スレッドを開いて3体で進めて。";
const ws = mkdtempSync(join(tmpdir(), "hive-e2e-"));
const bus = new Bus();
const config = loadConfig();
config.workspace = ws;
config.worktrees = { dir: join(ws, "wt") };
config.ui = { port: 7790 };
config.budget = { maxTokensPerRun: 150000 }; // 実走テストの費用上限(1ランあたり)
config.chat = { ...(config.chat ?? {}), autoContinueRounds: 2, staggerMs: 1000 };
config.discovery = { intervalSec: 30, testCommand: null }; // シナリオ用テストコマンドを引き継がない

wireConsoleLog(bus);

const stats = { deltas: 0, spawned: 0, merges: 0, claims: 0 };
const working = new Set();
bus.on("agent.delta", () => stats.deltas++);
bus.on("agent.spawned", (p) => { stats.spawned++; working.add(p.agent.id); });
bus.on("agent.status", (p) => {
  if (p.status === "working") working.add(p.agent);
  else working.delete(p.agent);
});
bus.on("merge.completed", () => stats.merges++);
bus.on("task.claimed", () => stats.claims++);
bus.on("usage", (p) => {
  const u = p.usage ?? {};
  process.stdout.write(`  [usage] ${p.agent}: prompt ${u.promptTokens ?? 0} / cost $${(u.costUsd ?? 0).toFixed(4)}\n`);
});

const ctl = await runChat({ config, bus });
ctl.say(task);

// 完了判定: 稼働エージェントが居なくなり20秒安定したら完了。
// 発見器起票の残タスク(open)は次ラウンドの請求対象なので完了扱い(サマリに件数を出す)。
const tasks = new TaskBlackboard(ws, bus);
const started = Date.now();
let stableSince = null;
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const snap = tasks.snapshot();
  const elapsedMin = ((Date.now() - started) / 60000).toFixed(1);
  process.stdout.write(`[${elapsedMin}分] open=${snap.open.length} claimed=${snap.claimed.length} done=${snap.done.length} working=${working.size} threads=${ctl.listThreads().join(",") || "なし"}\n`);
  if (working.size === 0) {
    if (stableSince && Date.now() - stableSince > 20000) break; // 20秒間変化なしで完了
    stableSince ??= Date.now();
  } else {
    stableSince = null;
  }
  if (Date.now() - started > 10 * 60 * 1000) {
    process.stdout.write("[タイムアウト] 10分で打ち切り(ここまでの状態を報告します)\n");
    break;
  }
}

// サマリ
const snap = tasks.snapshot();
console.log("\n===== E2Eサマリ =====");
console.log(`ワークスペース: ${ws}`);
console.log(`タスク: open=${snap.open.length} claimed=${snap.claimed.length} done=${snap.done.length}`);
console.log(`統計: delta ${stats.deltas}件 / スポーン ${stats.spawned}件 / マージ ${stats.merges}件 / 請求 ${stats.claims}件`);
for (const f of ["state/board__main__.jsonl", "state/threads.json", "state/mem-lead.json"]) {
  console.log(`永続化 ${f}: ${existsSync(join(ws, f)) ? "あり" : "なし"}`);
}
console.log("===== 完了 =====\n(一時ワークスペースは検証用。削除する場合は上のパスを rm -rf)");
process.exit(0);
