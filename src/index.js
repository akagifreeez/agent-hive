import { loadConfig } from "./config.js";
import { OpenAIModel } from "./model/openai.js";
import { runScenario } from "./runner.js";
import { Bus } from "./engine/board.js";
import { startUi } from "./ui/server.js";

function usage() {
  console.log(`agent-hive — 複数エージェントが同一ワークスペースで同時作業するハーネス

  node src/index.js --run     ヘッドレス実行(UI無し。結果をコンソールへ)
  node src/index.js --serve   UI付き実行(localhost、シナリオは自動開始)`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return usage();
  const config = loadConfig(args.includes("--config") ? args[args.indexOf("--config") + 1] : undefined);
  const bus = new Bus();
  wireConsoleLog(bus);

  const modelFactory = () => new OpenAIModel(config.model);

  if (args.includes("--serve")) {
    await startUi({ config, modelFactory, bus });
  } else {
    const snapshot = await runScenario({ config, modelFactory, bus });
    printTranscript(snapshot);
    const failed = snapshot.results.some((r) => !r.ok);
    process.exit(failed ? 1 : 0);
  }
}

function wireConsoleLog(bus) {
  bus.on("scenario.started", (p) => console.log(`▶ シナリオ開始: ${p.name} (タスク: ${p.tasks.join(", ")})`));
  bus.on("task.claimed", (p) => console.log(`✋ ${p.agent} が ${p.taskId} を請求`));
  bus.on("tool.call", (p) => console.log(`🔧 ${p.agent} ${p.tool} ${JSON.stringify(p.args).slice(0, 100)}`));
  bus.on("task.finished", (p) => console.log(`✅ ${p.agent} が ${p.taskId} を完了`));
  bus.on("agent.status", (p) => console.log(`● ${p.agent}: ${p.status}`));
  bus.on("agent.error", (p) => console.error(`✖ ${p.agent} (turn ${p.turn}): ${p.error}`));
  bus.on("task.created", (p) => console.log(`➕ タスク投入: ${p.taskId}`));
  bus.on("merge.completed", (p) => console.log(`🔀 ${p.agent} が ${p.taskId} をmainへマージ`));
  bus.on("merge.conflict", (p) => console.warn(`⚠ ${p.agent} の ${p.taskId} はマージ競合(解決ループへ)`));
  bus.on("discovery.created", (p) => console.log(`🔍 発見器が仕事を検出: ${p.taskId}`));
  bus.on("discovery.resolved", (p) => console.log(`🔍 発見器が自動解決: ${p.taskId}`));
  bus.on("permission.request", (p) => console.warn(`🔐 承認要求 #${p.id}: ${p.command.slice(0, 100)} (UIまたはタイムアウト待ち)`));
  bus.on("permission.denied", (p) => console.warn(`🚫 ${p.agent} のコマンドが拒否`));
  bus.on("board", (p) => console.log(`📢 [${p.from}] ${p.text.split("\n")[0].slice(0, 100)}`));
  bus.on("scenario.warn", (p) => console.warn(`⚠ ${p.message}`));
  bus.on("scenario.finished", () => console.log("■ シナリオ終了"));
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
