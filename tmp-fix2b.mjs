// 修復2b: 異常な3行窓 ["});", "  rmTree(ws);", "});"] を1箇所だけ検出して後ろ2行を除去
import { readFileSync, writeFileSync } from "node:fs";
const path = "test/task-id-uniqueness.test.js";
const raw = readFileSync(path, "utf8");
const nl = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(nl);
let removed = 0;
const out = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i], n1 = lines[i + 1] ?? "", n2 = lines[i + 2] ?? "";
  if (removed === 0 && l.trim() === "});" && n1.trim() === "rmTree(ws);" && n2.trim() === "});") {
    out.push(l);
    i += 2;
    removed++;
    continue;
  }
  out.push(l);
}
if (removed !== 1) throw new Error("残骸行が見つかりません removed=" + removed);
writeFileSync(path, out.join(nl));
console.log("fixed: 残骸削除 removed=", removed);
