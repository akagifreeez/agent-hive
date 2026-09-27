import { readFileSync, writeFileSync } from "node:fs";

const f = "src/ui/server.js";
let s = readFileSync(f, "utf8").replace(/\r\n/g, "\n");

// 1) startUi直後にUsageLedger不使用・usage.round購読へ予算監視を足す。
//    live初期化ブロックの後、tasks定義の前に挿入。
const anchor1 = `  const tasks = new TaskBlackboard(config.workspace, bus);`;
const inject1 = `  // usage予算アラート(config.chat.budgetAlertUsd): ラウンド終了ごとのusage.roundで
  // 台帳累積コストを監視し、しきい値を初めて超えたらメインボードに1回だけ告知する。
  // 以後は繰り返さない(告知済みフラグ)。未設定なら何もしない。
  const budgetAlertUsd = Number(config.chat?.budgetAlertUsd ?? NaN);
  let budgetAlerted = false; // 1回だけ告知のためのフラグ
  const budgetState = { thresholdUsd: Number.isFinite(budgetAlertUsd) ? budgetAlertUsd : null, costUsd: 0, exceeded: false };
  bus.on("usage.round", (p) => {
    const cost = p?.totals?.costUsd ?? 0;
    budgetState.costUsd = cost;
    if (!Number.isFinite(budgetAlertUsd) || budgetAlerted || !(cost > budgetAlertUsd)) return;
    budgetAlerted = true;
    budgetState.exceeded = true;
    live.board.push({ id: \`budget-\${Date.now()}\`, from: "system", text: \`[予算超過] 累積コストが設定(\` + String(budgetAlertUsd) + \`$)を超えました。予算超過: 累積\$\` + cost.toFixed(2), at: Date.now(), thread: "__main__" });
  });

  const tasks = new TaskBlackboard(config.workspace, bus);`;

if (!s.includes(anchor1)) throw new Error("anchor1 not found");
s = s.replace(anchor1, inject1);

// 2) usage.roundの既存persistUsageハンドラはそのまま(二重購読でOK・責務が別)。
// 3) /api/state へ budget を配る
const anchor2 = `, monitorPort: config.ui.monitorPort ?? null`;
const inject2 = `, monitorPort: config.ui.monitorPort ?? null, budget: budgetState`;

if (!s.includes(anchor2)) throw new Error("anchor2 not found");
s = s.replace(anchor2, inject2);

writeFileSync(f, s);
console.log("OK: server.js patched");
