import { readFileSync, writeFileSync } from "node:fs";

const f = "src/ui/public/index.html";
let s = readFileSync(f, "utf8");
const lines = s.split("\n");

// 競合マーカーを行頭アンカーで探す(======はCSSコメントに誤マッチするため^$で完全一致)
let start = -1, mid = -1, end = -1;
for (let i = 0; i < lines.length; i++) {
  const L = lines[i];
  if (start < 0 && L === "<<<<<<< Updated upstream") { start = i; continue; }
  if (start >= 0 && mid < 0 && L === "=======") { mid = i; continue; }
  if (start >= 0 && mid >= 0 && L === ">>>>>>> Stashed changes") { end = i; break; }
}
if (start < 0 || mid < 0 || end < 0) throw new Error("conflict block not found: " + start + "," + mid + "," + end);

// main側(Updated upstream)を採用: 自分の版(mid+1..end-1)とマーカー3行を削除
lines.splice(mid + 1, end - mid - 1); // 自分の版
lines.splice(mid, 1);                 // =======
lines.splice(start, 1);               // <<<<<<<

writeFileSync(f, lines.join("\n"));
console.log("conflict resolved (main side), markers were at", start + 1, mid + 2, end + 1);
