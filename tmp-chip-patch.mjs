// ui-progress-chip: index.html への進捗チップ実装パッチ(CRLF安全・行配列+JSON.stringifyで組み立て)
import { readFileSync, writeFileSync } from "node:fs";

const file = "src/ui/public/index.html";
let src = readFileSync(file, "utf8");
const orig = src;

// ---------- 1) CSS 追記(#ws-chip:hover の行の後) ----------
const cssLines = [
  "  /* ============ タスク進捗チップ(ヘッダー右上・進行の見え化) ============ */",
  "  #progress-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--sub); background: var(--fill); border: 1px solid var(--separator); border-radius: 4px; padding: 2px 8px; margin-left: 10px; cursor: pointer; flex-shrink: 0; white-space: nowrap; font-family: var(--font-mono); }",
  "  #progress-chip:hover { color: var(--label); border-color: var(--line-strong); }",
  "  #progress-chip.on { color: var(--accent); border-color: var(--accent); background: var(--accent-fill); }",
  "  #progress-panel { display: none; position: absolute; top: 100%; right: 0; margin-top: 6px; z-index: 60; width: min(460px, 90vw); max-height: 60vh; overflow: auto; background: var(--bg-elevated); border: 1px solid var(--line-strong); border-radius: 8px; box-shadow: var(--shadow-overlay); padding: 8px 10px; font-size: 12px; }",
  "  #progress-panel .pc-sec { font-weight: 600; color: var(--label); margin: 6px 0 4px; }",
  "  #progress-panel .pc-none { color: var(--label-tertiary); padding: 2px 0 6px; }",
  "  #progress-panel .pc-row { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; border-bottom: 1px solid var(--separator); min-width: 0; }",
  "  #progress-panel .pc-id { font-family: var(--font-mono); color: var(--accent); flex-shrink: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  "  #progress-panel .pc-sum { color: var(--sub); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  "  #progress-panel .pc-ag { color: var(--label-tertiary); flex-shrink: 0; font-size: 11px; }",
  "  #progress-panel .pc-done .pc-id { color: var(--ok); }",
];
const cssAnchor = "  #ws-chip:hover { color: var(--label); border-color: var(--line-strong); }";
if (!src.includes(cssAnchor)) throw new Error("css anchor not found");
src = src.replace(cssAnchor, cssAnchor + "\r\n" + cssLines.join("\r\n"));

// ---------- 2) HTML: チップ+パネル要素(panel-btn の前) ----------
const htmlLines = [
  '      <div id="progress-wrap">',
  '        <div id="progress-chip" title="タスク進捗(クリックで一覧)">✓ 0 / 0</div>',
  '        <div id="progress-panel"></div>',
  "      </div>",
];
const htmlAnchor = '      <button id="panel-btn" title="右パネルの表示/非表示">パネル</button>';
if (!src.includes(htmlAnchor)) throw new Error("html anchor not found");
src = src.replace(htmlAnchor, htmlLines.join("\r\n") + "\r\n" + htmlAnchor);

// ---------- 3) JS: syncProgressChip + renderProgressPanel ----------
const jsLines = [
  "// ================= タスク進捗チップ(進行の見え化) =================",
  "// ヘッダー右上に「✓ y / x(作業中 n)」を常時表示。y=done、x=open+claimed+done、n=claimed。",
  "// データ源は /api/state の taskList のみ。クリックで作業中/直近完了のパネルを出す。",
  "// SSE(task.created/claimed/finished/merge.completed)は既存refreshSoon→renderAll経由で即時更新。",
  "let progressPanelOpen = false; // パネルの開閉状態(描画ごとに保持)",
  "function progressStats(state) {",
  "  const l = state?.taskList ?? { open: [], claimed: [], done: [] };",
  "  return { done: l.done.length, total: l.open.length + l.claimed.length + l.done.length, claimed: l.claimed.length };",
  "}",
  "function syncProgressChip(state) {",
  "  const chip = document.getElementById(\"progress-chip\");",
  "  if (!chip) return;",
  "  const s = progressStats(state);",
  "  chip.textContent = \"✓ \" + s.done + \" / \" + s.total + (s.claimed ? \"(作業中 \" + s.claimed + \")\" : \"\");",
  "  chip.classList.toggle(\"on\", s.claimed > 0);",
  "  const panel = document.getElementById(\"progress-panel\");",
  "  if (panel) { panel.style.display = progressPanelOpen ? \"block\" : \"none\"; }",
  "  if (progressPanelOpen) renderProgressPanel();",
  "}",
  "function renderProgressPanel() {",
  "  const panel = document.getElementById(\"progress-panel\");",
  "  if (!panel || !lastState) return;",
  "  const l = lastState.taskList ?? { open: [], claimed: [], done: [] };",
  "  const mk = (cls, id, sum, ag) => {",
  "    const row = document.createElement(\"div\");",
  "    row.className = cls;",
  "    const i = document.createElement(\"span\"); i.className = \"pc-id\"; i.textContent = id;",
  "    const m = document.createElement(\"span\"); m.className = \"pc-sum\"; m.textContent = sum;",
  "    row.appendChild(i); row.appendChild(m);",
  "    if (ag) { const a = document.createElement(\"span\"); a.className = \"pc-ag\"; a.textContent = ag; row.appendChild(a); }",
  "    return row;",
  "  };",
  "  panel.textContent = \"\";",
  "  const s1 = document.createElement(\"div\"); s1.className = \"pc-sec\"; s1.textContent = \"作業中(\" + l.claimed.length + \")\";",
  "  panel.appendChild(s1);",
  "  if (l.claimed.length === 0) { const n = document.createElement(\"div\"); n.className = \"pc-none\"; n.textContent = \"作業中のタスクはありません\"; panel.appendChild(n); }",
  "  for (const t of l.claimed) panel.appendChild(mk(\"pc-row\", t.id, t.summary ?? \"\", \"@\" + (t.agent ?? \"?\")));",
  "  const s2 = document.createElement(\"div\"); s2.className = \"pc-sec\"; s2.textContent = \"直近の完了\";",
  "  panel.appendChild(s2);",
  "  const doneDesc = [...l.done].reverse().slice(0, 10); // 新しい順・上位10件",
  "  if (doneDesc.length === 0) { const n = document.createElement(\"div\"); n.className = \"pc-none\"; n.textContent = \"完了タスクはまだありません\"; panel.appendChild(n); }",
  "  for (const t of doneDesc) panel.appendChild(mk(\"pc-row pc-done\", t.id, t.summary ?? \"\", \"@\" + (t.agent ?? \"?\")));",
  "}",
  "$(\"progress-chip\").onclick = () => { progressPanelOpen = !progressPanelOpen; renderAll(); };",
];
const jsAnchor = "function renderAll() {";
if (!src.includes(jsAnchor)) throw new Error("js anchor not found");
src = src.replace(jsAnchor, jsLines.join("\r\n") + "\r\n\r\n" + jsAnchor);

// ---------- 4) renderAll から syncProgressChip を呼ぶ ----------
const callAnchor = "  syncWsChip();";
if (!src.includes(callAnchor)) throw new Error("call anchor not found");
src = src.replace(callAnchor, callAnchor + "\r\n  syncProgressChip(lastState);");

writeFileSync(file, src);
console.log("patched OK. size:", src.length, "(was", orig.length + ")");
