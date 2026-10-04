import { readFileSync, writeFileSync } from "node:fs";
const p = "src/engine/compact.js";
let s = readFileSync(p, "utf8");
const bad = "  if (!disabled(maxBytes)) {\n    while (keep > 1 && protectedBytes() > maxBytes) keep--;\n  }";
// 過剰縮小防止: dropped>=1 で上限に収まるならkeepを維持。収まらないときだけ削る。
const good = [
  "  if (!disabled(maxBytes)) {",
  "    // dropped>=1で上限に収まるならkeepを維持する。収まらない場合だけ保護枠を削る",
  "    // (過剰縮小で余分に刈らない: テスト契約「1件だけ落として4本残す」を守る)。",
  "    const fitsWith = (k) => head.reduce((s2, m) => s2 + bytes(m), 0)",
  "      + body.slice(-k).reduce((s2, m) => s2 + bytes(m), 0)",
  "      + bytes({ content: MEM_HEADER + \" \" + new Date().toISOString() }) <= maxBytes;",
  "    const droppedFor = (k) => body.length - k;",
  "    while (keep > 1 && (droppedFor(keep) < 1 || !fitsWith(keep))) keep--;",
  "  }",
].join("\n");
if (!s.includes(bad)) { console.error("ANCHOR-NOT-FOUND"); process.exit(1); }
s = s.replace(bad, good);
writeFileSync(p, s);
console.log("patched");
