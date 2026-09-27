import { readFileSync, writeFileSync } from "node:fs";

// src/ui/server.js へ usage予算アラートを注入するパッチ。
// 教訓(memory/constraints)に従い、バッククォートとドル波括弧は一切書かない。
const f = "src/ui/server.js";
let s = readFileSync(f, "utf8").replace(/\r\n/g, "\n");

const BT = String.fromCharCode(96); // バッククォート

const block = [
  '  // usage予算アラート(config.chat.budgetAlertUsd): ラウンド終了ごとのusage.roundで',
  '  // 台帳累積コストを監視し、しきい値を初めて超えたらメインボードに1回だけ告知する。',
  '  // 以後は繰り返さない(告知済みフラグ)。未設定なら何もしない。',
  '  const budgetAlertUsd = Number(config.chat?.budgetAlertUsd ?? NaN);',
  '  let budgetAlerted = false; // 1回だけ告知のためのフラグ',
  '  const budgetState = { thresholdUsd: Number.isFinite(budgetAlertUsd) ? budgetAlertUsd : null, costUsd: 0, exceeded: false };',
  '  bus.on("usage.round", (p) => {',
  '    const cost = p?.totals?.costUsd ?? 0;',
  '    budgetState.costUsd = cost;',
  '    if (!Number.isFinite(budgetAlertUsd) || budgetAlerted || !(cost > budgetAlertUsd)) return;',
  '    budgetAlerted = true;',
  '    budgetState.exceeded = true;',
  '    live.board.push({ id: ' + JSON.stringify("budget-") + ' + Date.now(), from: "system", text: ' + JSON.stringify("[予算超過] 累積コストが設定(") + ' + String(budgetAlertUsd) + ' + JSON.stringify("$)を超えました。予算超過: 累積$") + ' + cost.toFixed(2) });',
  '  });',
  '',
].join("\n");

const anchor = '  const tasks = new TaskBlackboard(config.workspace, bus);';
if (!s.includes(anchor)) throw new Error("anchor1 not found");
s = s.replace(anchor, block + anchor);

const anchor2 = ', monitorPort: config.ui.monitorPort ?? null';
if (!s.includes(anchor2)) throw new Error("anchor2 not found");
s = s.replace(anchor2, ', monitorPort: config.ui.monitorPort ?? null, budget: budgetState');

// BTは未使用の environmental variable guard: パッチ内でテンプレートリテラルを
// 作らないことを保証するためだけに存在(BTを使う箇所は無いはず)
if (BT !== "`") throw new Error("BT sanity");

writeFileSync(f, s);
console.log("patched OK");
