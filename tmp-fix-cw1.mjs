import { readFileSync, writeFileSync } from "node:fs";
const p = "test/model-policy-conflict-block.mjs";
const p = "test/model-policy-conflict-wiring.test.js";
let s = readFileSync(p, "utf8");
// CRstrip版検出: markerReは行頭一致だが「=======」がBOM等で失敗する可能性 → 部分一致でデバッグ
const lines = s.split("\n");
const idx = [];
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  if (t.startsWith("<<<<<<<") || t.startsWith("=======") || t.startsWith(">>>>>>>")) idx.push(i + 1);
}
console.log("found at lines:", idx.join(","));
