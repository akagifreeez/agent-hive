// 一時スクリプト(実行後削除): impl-6のthread.test.js競合を「main側コメントを採用」で解消。
// コード実体(landingSignal: () => true)は両側同一でコメント差分のみ。main側が公式
// (5bf76b6移植注記つき)なのでmain側を採る。
import { readFileSync, writeFileSync } from "node:fs";

const f = "test/heavy/thread.test.js";
const lines = readFileSync(f, "utf8").split("\n");
const out = [];
let mode = 0; // 0=通常 1=HEAD側 2=main側
let kept = 0, dropped = 0;
for (const raw of lines) {
  const line = raw.replace(/\r$/, "");
  if (/^<{7} HEAD\s*$/.test(line)) { mode = 1; continue; }
  if (/^={7}\s*$/.test(line) && mode === 1) { mode = 2; continue; }
  if (/^>{7} main\s*$/.test(line)) { mode = 0; continue; }
  if (mode === 1) { dropped++; continue; } // HEAD側(旧コメント)は捨てる
  if (mode === 2) { out.push(line); kept++; continue; } // main側(公式コメント)を採用
  out.push(line);
}
writeFileSync(f, out.join("\n"), "utf8");
const markers = out.filter((l) => /^<{7}\s|^={7}\s*$|^>{7}\s/.test(l)).length;
console.log(f, "kept(main):", kept, "dropped(head-comment):", dropped, "markers-remaining:", markers);
console.log("DONE");
