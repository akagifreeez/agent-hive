import { readFileSync, writeFileSync } from "node:fs";

// chat.jsの競合: HEAD(unsubscribe版)を採用する。main側のdispose/disposedも妥当だが、
// HEAD側は回帰テスト(test/closed-thread-unsub.test.js)で動作保証済み。
const path = "src/engine/chat.js";
const src = readFileSync(path, "utf8");
const nl = src.includes("\r\n") ? "\r\n" : "\n";
const lines = src.split(nl);
const norm = (s) => s.replace(/\r$/, "");
const marks = [];
for (let i = 0; i < lines.length; i++) {
  const b = norm(lines[i]);
  if (b.startsWith("<<<<<<<") || b === "=======" || b.startsWith(">>>>>>>")) marks.push({ type: b.startsWith("<<<<<<<") ? "start" : b === "=======" ? "mid" : "end", i });
}
const startI = marks.find((m) => m.type === "start").i;
const midI = marks.find((m) => m.type === "mid").i;
const endI = marks.find((m) => m.type === "end").i;
const head = lines.slice(startI + 1, midI);
// HEAD側の最後の '  }' はコンストラクタ終端。HEADブロックはそのまま使う
lines.splice(startI, endI - startI + 1, ...head);
writeFileSync(path, lines.join(nl));
console.log("chat.js resolved: HEAD adopted (" + head.length + " lines)");
