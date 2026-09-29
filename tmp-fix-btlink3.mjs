// tmp-fix-btlink3.mjs — extractElements のリンク正規表現のバックスラッシュ数を修正(2個→1個)。目的達成後に削除
import { readFileSync, writeFileSync } from "node:fs";
const p = "src/engine/browser-tools.js";
let s = readFileSync(p, "utf8");
const BS = String.fromCharCode(92);
const DQ = String.fromCharCode(34);

// 現状のソース字面(壊れている): "<a\\s[^>]*?href=(?:\\\"([^\"]*)\\\"|'[^']*'|([^\\s>]+))[^>]*>([\\s\\S]*?)</a\\s*>"
// 正しい: "<a\\s..." → JS文字列値が \s になるにはソース上 \s(1個)でよい(通常の'...'文字列内)
const oldSeg = "new RegExp(" + DQ + "<a" + BS + BS + "s[^>]*?href=(?:" + BS + BS + DQ + "([^\"]*)" + BS + BS + DQ + "|'[^']*'|([^" + BS + BS + "s>]+))[^>]*>([" + BS + BS + "s" + BS + BS + "S]*?)</a" + BS + BS + "s*>" + DQ + ", " + DQ + "gi" + DQ + ")";
if (!s.includes(oldSeg)) { console.log("OLD-NOT-FOUND"); process.exit(1); }
// 正: バックスラッシュ1個ずつ。\\\" は \" に、\\s は \s に
const newSeg = "new RegExp(" + DQ + "<a" + BS + "s[^>]*?href=(?:" + BS + DQ + "([^\"]*)" + BS + DQ + "|'[^']*'|([^" + BS + "s>]+))[^>]*>([" + BS + "s" + BS + "S]*?)</a" + BS + "s*>" + DQ + ", " + DQ + "gi" + DQ + ")";
s = s.replace(oldSeg, newSeg);
writeFileSync(p, s);
console.log("fixed");
