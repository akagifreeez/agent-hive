// 一時パッチ: index.html のCSSにコンテキストバーのスタイルを追加(実行後削除)
import { readFileSync, writeFileSync } from "node:fs";
const p = "src/ui/public/index.html";
let s = readFileSync(p, "utf8");
const CRLF = String.fromCharCode(13, 10);
if (s.includes(".ctxbar {")) { console.log("ALREADY"); process.exit(0); }
const anchor = '  .alog .entry.compact .txt { color: var(--label-secondary); }' + CRLF;
if (!s.includes(anchor)) { console.error("anchor not found"); process.exit(1); }
const ins = anchor
  + '  /* コンテキストウィンドウ消費量(イシュー#17): 詳細パネル先頭のバー */' + CRLF
  + '  .ctxbox { margin: 0 0 8px; font-size: 11px; color: var(--label-secondary); font-family: var(--font-mono); }' + CRLF
  + '  .ctxtext { margin-bottom: 3px; }' + CRLF
  + '  .ctxbar { height: 5px; background: var(--fill-strong); border-radius: 3px; overflow: hidden; }' + CRLF
  + '  .ctxbar .ctx-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width var(--duration) var(--ease); }' + CRLF
  + '  .ctxbar .ctx-fill.hot { background: var(--err); }' + CRLF;
s = s.replace(anchor, ins);
writeFileSync(p, s);
console.log("PATCHED");
