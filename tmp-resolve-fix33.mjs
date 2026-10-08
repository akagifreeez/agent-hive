// 一時スクリプト(実行後削除): stash pop競合を「main側(HEAD)を採用」で解消する。
// 根拠: mainにはusage-round-delta.test.js(issue#33修正の公式テスト)があり、main側実装は全テスト緑済み。
// stash側(impl-20残置)は同一イシュー#33の先行ドラフトで、main側が公式テスト込みで優位。
import { readFileSync, writeFileSync } from "node:fs";

const files = ["src/engine/chat.js", "src/engine/usage.js"];

for (const f of files) {
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  const out = [];
  let mode = 0; // 0=通常 1=upstream側 2=stash側
  let kept = 0, dropped = 0;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (/^<{7} Updated upstream\s*$/.test(line)) { mode = 1; continue; }
    if (/^={7}\s*$/.test(line) && mode === 1) { mode = 2; continue; }
    if (/^>{7} Stashed changes\s*$/.test(line)) { mode = 0; continue; }
    if (mode === 1) { out.push(line); kept++; }
    else if (mode === 2) { dropped++; continue; }
    else out.push(line);
  }
  writeFileSync(f, out.join("\n"), "utf8");
  const markers = out.filter((l) => /^<{7}\s|^={7}\s*$|^>{7}\s/.test(l)).length;
  console.log(f, "kept(upstream):", kept, "dropped(stash):", dropped, "markers-remaining:", markers);
}
console.log("DONE");
