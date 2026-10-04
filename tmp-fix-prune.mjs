import { readFileSync, writeFileSync } from "node:fs";
const f = "src/engine/compact.js";
let s = readFileSync(f, "utf8");
const a = "  if (!disabled(maxBytes)) {\n    // dropped(初期keepで刈れる件数)が0のときだけ保護枠を削る。\n    // 1件以上刈れるならkeepを維持(上限に収まらない単価のメッセージでも、刈り取り自体で\n    // バイト合計は下がるため「何も起きない不正状態」を先に解消する。)\n\n    const droppedFor = (k) => body.length - k;\n    while (keep > 1 && droppedFor(keep) < 1 && keepRecent > body.length) keep--;\n  }";
const b = "  if (!disabled(maxBytes)) {\n    // dropped(初期keepで刈れる件数)が0のとき、または刈り取り後も上限を超え続けるときは\n    // 保護枠を削る(最低1件は保持)。単価が大きいメッセージでは1件保持でも超過するが、\n    // それでもバイト合計は下がるため「何も起きない不正状態」を先に解消する。\n    const keptBytesFor = (k) => head.reduce((acc, m) => acc + bytes(m), 0)\n      + body.slice(-k).reduce((acc, m) => acc + bytes(m), 0);\n    while (keep > 1 && (body.length - keep < 1 || keptBytesFor(keep) > maxBytes)) keep--;\n  }";
if (!s.includes(a)) { console.log("NOT FOUND"); process.exit(1); }
s = s.replace(a, b);
writeFileSync(f, s);
console.log("patched pruneMemories");
