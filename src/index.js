import { loadConfig } from "./config.js";
import { OpenAIModel } from "./model/openai.js";
import { runScenario, runChat } from "./runner.js";
import { Bus } from "./engine/board.js";
import { startUi } from "./ui/server.js";
import { wireConsoleLog } from "./log.js";

function usage() {
  console.log(`agent-hive — 複数エージェントが同一ワークスペースで同時作業するハーネス

  node src/index.js --run     ヘッドレス実行(UI無し。結果をコンソールへ)
  node src/index.js --serve   UI付き実行(localhost、シナリオは自動開始)
  node src/index.js --chat    メインチャット常駐モード(UIの入力欄から指示。シナリオ自動開始なし)`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return usage();
  const config = loadConfig(args.includes("--config") ? args[args.indexOf("--config") + 1] : undefined);
  const bus = new Bus();
  wireConsoleLog(bus);

  const modelFactory = () => new OpenAIModel(config.model);

  if (args.includes("--chat")) {
    const controller = await runChat({ config, bus });
    await startUi({ config, bus, autoStart: false, onSay: (text, thread) => controller.say(text, thread), onFeedback: (req) => controller.feedback(req), onThreadPause: (req) => controller.setThreadPaused(req) });
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
