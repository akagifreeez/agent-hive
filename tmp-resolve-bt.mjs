import { readFileSync, writeFileSync } from "node:fs";
const stripCR = (s) => s.replace(/\r$/, "");
const file = "test/browser-tools.test.js";
const lines = readFileSync(file, "utf8").split("\n");
const out = [];
let state = 0;
for (const raw of lines) {
  const l = stripCR(raw);
  if (l.startsWith("<<<<<<<")) { state = 1; continue; }
  if (l.startsWith("=======") && state === 1) { state = 2; continue; }
  if (l.startsWith(">>>>>>>") && state === 2) { state = 0; continue; }
  // 両側はコード同一・コメント文言のみ差 → main側の文言を採用
  if (state === 0 || state === 2) out.push(raw);
}
writeFileSync(file, out.join("\n"));
console.log("markers_left=" + out.filter((x) => /^[<>=]{7}/.test(stripCR(x))).length);
