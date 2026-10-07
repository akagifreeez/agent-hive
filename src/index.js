import { loadConfig } from "./config.js";
import { createModelFactory } from "./model/factory.js";
import { runScenario, runChat } from "./runner.js";
import { Bus } from "./engine/board.js";
import { startUi } from "./ui/server.js";
import { chatUiHandlers } from "./ui/chat-wiring.js";
import { wireConsoleLog } from "./log.js";
import { wireCliNotify, wireStallNotify } from "./notify.js";
import { installProcessGuard } from "./engine/process-guard.js";

function usage() {
  console.log(`agent-hive — 複数エージェントが同一ワークスペースで同時作業するハーネス

  node src/index.js --run     ヘッドレス実行(UI無し。結果をコンソールへ)
  node src/index.js --serve   UI付き実行(localhost、シナリオは自動開始)
  node src/index.js --chat    メインチャット常駐モード(UIの入力欄から指示。シナリオ自動開始なし)

  稼働中のhiveを端末から操作するCLI: node bin/hive.js --help`);
}

async function main() {
  // プロセス生存ガード(long-run-resilience): 未捕捉rejection/例外で落ちない。
  // 黙殺しない: ログ(run-chat.err.log)へスタック全文+コンソール+board[システム]投稿+notify経路。
  // boardはまだ無いので最初はコンソールのみで開始し、Bus生成後に結線し直す。
  let mainBusRef = null;
  let notifyRef = null;
  const guard = installProcessGuard(null, {
    logFile: GUARD_LOG_DEFAULT,
    log: (line) => console.error(line),
    notify: (line) => { try { notifyRef?.(line); } catch { /* 通知失敗でガードを止めない */ } },
  });
  // Bus生成後: board[システム]投稿とnotify配線を後付けで結ぶ(process.errorを監視)
  const offWireLater = () => {
    if (!mainBusRef) return;
    mainBusRef.on("process.error", (p) => {
      try { mainBusRef?.__mainBoardRef?.post("system", `[プロセス警告] ${p.kind} を捕捉(プロセスは生存しています): ${String(p.message).slice(0, 300)}`); } catch { /* 投稿失敗は無視 */ }
    });
    mainBusRef.on("process.burst", (p) => {
      try { mainBusRef?.__mainBoardRef?.post("system", `[プロセス警告] 異常頻度: 1時間に${p.count}件(しきい値${p.threshold}件超)。run-chat.err.log を確認してください`); } catch { /* 同上 */ }
    });
  };
  offWireLater();
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return usage();
  const config = loadConfig(args.includes("--config") ? args[args.indexOf("--config") + 1] : undefined);
  const bus = new Bus();
  wireConsoleLog(bus);

  const modelFactory = createModelFactory(config);

  // CLI通知(#11): UIを立てない実行(--run/シナリオ直実行)はコンソール配信だけ。
  // --chat/--serve はstartUi側で同じbusへ配線する(コンソール+監視/monitor配信)ので二重にやらない
  if (!args.includes("--chat") && !args.includes("--serve")) {
    wireCliNotify(bus, { longTaskSec: config.notify?.longTaskSec ?? 600 });
    wireStallNotify(bus, { enabled: config.notify?.stop !== false, stallSec: config.notify?.stallSec ?? 600 });
  }

  if (args.includes("--chat")) {
    // デスクトップ殻と同じ順(UIの待ち受けを先に立ててからrunChat)。
    // 逆だとリーダーの登録イベント(thread.opened)がUI立ち上がり前に消える。
    // controllerは後から入るのでgetterで渡す
    let controller = null;
    await startUi({ config, bus, autoStart: false, ...chatUiHandlers(() => controller) });
    controller = await runChat({ config, bus });
    return;
  }

  if (args.includes("--serve")) {
    await startUi({ config, modelFactory, bus });
  } else {
    const snapshot = await runScenario({ config, modelFactory, bus });
    printTranscript(snapshot);
    const failed = snapshot.results.some((r) => !r.ok);
    process.exit(failed ? 1 : 0);
  }
}

function printTranscript(snapshot) {
  console.log("\n===== ボードの流れ =====");
  for (const p of snapshot.board) console.log(`\n[${p.from}] #${p.id}\n${p.text}`);
  console.log("\n===== タスク状態 =====");
  console.log(`open:    ${snapshot.tasks.open.join(", ") || "(なし)"}`);
  console.log(`claimed: ${snapshot.tasks.claimed.join(", ") || "(なし)"}`);
  console.log(`done:    ${snapshot.tasks.done.join(", ") || "(なし)"}`);
}

main().catch((err) => {
  console.error("[agent-hive] 起動エラー:", err.message);
  process.exit(1);
});
