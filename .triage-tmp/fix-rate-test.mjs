import fs from "fs";
const p = "test/long-run-resilience.test.js";
let src = fs.readFileSync(p, "utf8");
const before = src;
// rateLimit/rateWindowMsは実装のopts名。typosを修正
src = src.replace("rateLimit: 3, rateWindowMs: 60_000", "rateLimit: 3, rateWindowMs: 60_000");
src = src.replace("rateLimit: 3, rateWindowMs: 60_000", "rateLimit: 3, rateWindowMs: 60_000");
src = src.replace("onNotify", "onNotify");
if (src !== before) { fs.writeFileSync(p, src); console.log("changed"); }
else console.log("no change");
// 該当行の確認
for (const [i, l] of src.split("\n").entries()) if (l.includes("rateLimit")) console.log(i + 1, l.trim());
