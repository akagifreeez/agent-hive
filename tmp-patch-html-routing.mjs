// パッチ4: index.html — 設定ウィンドウの詳細設定へ「モデルルーティング」スイッチを追加
// (1) HTML: 権限モードのselect行の後にスイッチ行を挿入
// (2) JS: 設定ダイアログを開く処理へ状態表示+トグルハンドラを追加
import { readFileSync, writeFileSync } from "node:fs";

const p = "src/ui/public/index.html";
let src = readFileSync(p, "utf8");
if (src.includes("\r\n")) src = src.split("\r\n").join("\n");

function mustReplace(oldText, newText, label) {
  if (!src.includes(oldText)) {
    console.error("PATCH4 FAIL: 見つかりません: " + label);
    process.exit(1);
  }
  src = src.replace(oldText, newText);
}

// --- (A) HTML行の挿入(権限モード行の直後) ---
mustReplace(
  '      <div class="set-row"><label>権限モード</label>\n        <select id="set-perm"><option value="normal">normal(要承認)</option><option value="auto">auto(自動許可)</option></select>\n      </div>',
  [
    '      <div class="set-row"><label>権限モード</label>',
    '        <select id="set-perm"><option value="normal">normal(要承認)</option><option value="auto">auto(自動許可)</option></select>',
    '      </div>',
    '    <div class="set-row"><label>モデルルーティング</label>',
    '        <div style="flex:1">',
    '          <label style="display:flex;align-items:center;gap:6px;font-size:12px"><input type="checkbox" id="set-routing" style="width:auto"> 重い仕事は高性能モデルへ自動振り分け</label>',
    '          <div style="font-size:11px;color:var(--label-tertiary);margin-top:3px" id="set-routing-note"></div>',
    '        </div>',
    '      </div>',
  ].join("\n"),
  "html switch row",
);

// --- (B) JS: 設定ウィンドウを開くときの初期化(/api/routing を読んで反映) ---
// 掛かり処理: settings-dlgを開く処理(showSettings相当)を探す。renderModelsList()を呼んでいる開く処理をフック先にする
const anchorJs = 'async function renderModelsList() {';
if (!src.includes(anchorJs)) { console.error("PATCH4 FAIL: renderModelsList が無い"); process.exit(1); }

// settings-dlg を開く箇所(showModal)を探す
const openIdx = src.indexOf('settings-dlg');
let hookOk = false;
// 設定ボタンのクリックハンドラに showSettings 相当があるはず。$("settings-btn") を探す
const btnAnchor = '$("settings-btn")';
if (src.includes(btnAnchor)) hookOk = true;
console.log("PATCH4 INFO: settings-btn found=" + hookOk);

writeFileSync(p, src, "utf8");
console.log("PATCH4 OK(HTML部分): index.html へスイッチ行を追加");
