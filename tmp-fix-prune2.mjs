import { readFileSync, writeFileSync } from "node:fs";
const f = "src/engine/compact.js";
let s = readFileSync(f, "utf8");
const oldBlock = [
  "  if (!disabled(maxBytes)) {",
  "    // dropped(初期keepで刈れる件数)が0のときだけ保護枠を削る。",
  "    // 1件以上刈れるならkeepを維持(上限に収まらない単価のメッセージでも、刈り取り自体で",
  "    // バイト合計は下がるため「何も起きない不正状態」を先に解消する。)",
  "",
  "    const droppedFor = (k) => body.length - k;",
  "    while (keep > 1 && droppedFor(keep) < 1 && keepRecent > body.length) keep--;",
  "  }",
].join("\n");
const newBlock = [
  "  if (!disabled(maxBytes)) {",
  "    // dropped(初期keepで刈れる件数)が0のとき、または刈り取り後も上限を超え続けるときは",
  "    // 保護枠を削る(最低1件は保持)。単価が大きいメッセージでは1件保持でも超過するが、",
  "    // それでもバイト合計は下がるため「何も起きない不正状態」を先に解消する。",
  "    const keptBytesFor = (k) => head.reduce((acc, m) => acc + bytes(m), 0)",
  "      + body.slice(-k).reduce((acc, m) => acc + bytes(m), 0);",
  "    while (keep > 1 && (body.length - keep < 1 || keptBytesFor(keep) > maxBytes)) keep--;",
  "  }",
].join("\n");
if (!s.includes(oldBlock)) { console.log("NOT FOUND"); process.exit(1); }
s = s.replace(oldBlock, newBlock);
writeFileSync(f, s);
console.log("patched");
