// コンソールへの進行ログ(ヘッドレス実行とデスクトップアプリで共用)
export function wireConsoleLog(bus) {
  bus.on("scenario.started", (p) => console.log(`▶ シナリオ開始: ${p.name} (タスク: ${p.tasks.join(", ")})`));
  bus.on("task.claimed", (p) => console.log(`✋ ${p.agent} が ${p.taskId} を請求`));
  bus.on("task.created", (p) => console.log(`➕ タスク投入: ${p.taskId}`));
  bus.on("tool.call", (p) => console.log(`🔧 ${p.agent} ${p.tool} ${JSON.stringify(p.args).slice(0, 100)}`));
  bus.on("task.finished", (p) => console.log(`✅ ${p.agent} が ${p.taskId} を完了`));
  bus.on("agent.status", (p) => console.log(`● ${p.agent}: ${p.status}`));
  bus.on("agent.error", (p) => console.error(`✖ ${p.agent} (turn ${p.turn}): ${p.error}`));
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
