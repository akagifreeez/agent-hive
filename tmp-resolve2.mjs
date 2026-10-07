import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
const p = "src/model/openai.js";
const lines = readFileSync(p, "utf8").split(/\r?\n/);
// 147行目(1始まり)がHEAD開始。採用方針:
// - HEAD側(148-151)とbranch側(153-156)の内容を統合する(コメントはbranch側の詳述+HEADの観測行、コードはHEAD側の isAbortRelated/isRetryableNetworkError 判定)
const replacement = [
  "          // ストリーム途中切断もリトライ対象(再試行は最初から)。",
  "          // undiciの中断系(TypeError: terminated / Fetch.onAborted / ECONNRESET等)を",
  "          // ネットワーク系として正規化してリトライ契約へ乗せる(long-run-resilience:",
  "          // 2026-10-04のプロセス死対策)。中断観測の痕跡も採る(HIVE_DEBUG_FILE時)。",
  "          // リトライし切ったら行動化エラー(ループが次の行動を決められる形)として投げる",
  "          if (isAbortRelated(err)) noteAborted(err);",
  "          if (isRetryableNetworkError(err) && attempt <= RETRY_MAX_RETRIES) {",
];
// 0始まり: HEAD_STARTは146(=147行目)。ブロックは146..156(<<<<<<<から>>>>>>>まで)
const block = lines.slice(146, 157).map(l => l.replace(/\r$/, ""));
if (block[0] !== "<<<<<<< HEAD" || block[6] !== "=======" || block[11] !== ">>>>>>> agent/process-guard-impl") {
  console.error("予期しないブロック構造:", JSON.stringify(block, null, 1));
  process.exit(1);
}
const fixed = [...lines.slice(0, 146), ...replacement, ...lines.slice(157)];
writeFileSync(p, fixed.join("\n"), "utf8");
console.log("resolved openai.js");
