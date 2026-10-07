// 進行の見え化(本人指示「終わったのがわかりにくい」対策):
// - タブタイトルに作業中数(▶N)/アイドル(✓)を出す
// - 左下ステータスラインに「作業中N/アイドル」を常時表示
// - task.finished / merge.completed でトースト+デスクトップ通知(/notifyでON)
// index.htmlの静的検査で配線の存在を担保する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "src/ui/public/index.html"), "utf8");

test("UI: タブタイトルとステータスラインに作業中数を出す", () => {
  assert.match(html, /workingN \? `▶\$\{workingN\} ` : "✓ "/);
  assert.match(html, /document\.title !== pageTitle/);
  assert.match(html, /workTxt = workingN \? `作業中\$\{workingN\}` : "アイドル"/);
  assert.match(html, /bits = \[workTxt,/);
});

test("UI: task.finished / merge.completedでトースト+デスクトップ通知する", () => {
  assert.match(html, /type === "task\.finished" \|\| type === "merge\.completed"/);
  assert.match(html, /toast\("✓ " \+ msg, "ok"\)/);
  assert.match(html, /desktopNotify\("hive " \+ label, msg\)/);
});

test("UI: /notifyコマンドでデスクトップ通知をON/OFFできる", () => {
  assert.match(html, /notify: "デスクトップ通知のON\/OFF/);
  assert.match(html, /cmd === "notify"/);
  assert.match(html, /Notification\.requestPermission\(\)/);
  assert.match(html, /localStorage\.setItem\("hive-notify"/);
});

test("UI: desktopNotifyは許可済みかつONのときだけ発火する", () => {
  assert.match(html, /function desktopNotify\(title, body\) \{\s*\n\s*if \(!notifyOn \|\| typeof Notification === "undefined" \|\| Notification\.permission !== "granted"\) return;/);
});

// ---- タスク進捗チップ(ui-progress-chip): ヘッダー右上に「✓ y / x(作業中 n)」を常時表示 ----
// y=done件数 / x=open+claimed+doneの合計 / n=claimed件数。データ源は /api/state の taskList のみ。
test("UI: 進捗チップがヘッダー右上にあり、y/x計算と作業中ハイライトを持つ", () => {
  assert.match(html, /<div id="progress-wrap">/);
  assert.match(html, /<div id="progress-chip"/);
  assert.match(html, /function progressStats\(state\) \{/);
  assert.match(html, /done: l\.done\.length, total: l\.open\.length \+ l\.claimed\.length \+ l\.done\.length, claimed: l\.claimed\.length/);
  assert.match(html, /chip\.textContent = "✓ " \+ s\.done \+ " \/ " \+ s\.total \+ \(s\.claimed \? "\(作業中 " \+ s\.claimed \+ "\)" : ""\)/);
  assert.match(html, /chip\.classList\.toggle\("on", s\.claimed > 0\)/);
  assert.match(html, /syncProgressChip\(lastState\);/);
});

test("UI: 進捗チップのクリックでパネル(作業中一覧+直近完了15件+他N件)がトグルする", () => {
  assert.match(html, /function renderProgressPanel\(\) \{/);
  assert.match(html, /const doneDesc = \[\.\.\.l\.done\]\.reverse\(\);/);
  assert.match(html, /doneDesc\.slice\(0, 15\)/); // 完了は直近15件に絞る
  assert.match(html, /他\d+件|他" \+/); // 省略分の表記(「他N件」形式に統一)
  assert.match(html, /\$\("progress-chip"\)\.onclick/); // クリックトグル(ホバー表示は使わない)
});

test("UI: 進捗パネルはビューポート内に収める(右端基準+上限寸法+縦スクロール)", () => {
  // 幅800px×高さ600px相当の狭いビューポートでも画面外に出ない設定の固定:
  // - right:0 右端基準(左側へ伸びる)で横のはみ出しを構造的に防ぐ
  // - width: min(520px, 90vw) → 800px幅でも90vw=720pxなので実幅520pxで左に収まる
  // - max-height: 60vh → 600px高でも実高360pxで下にはみ出さない(超過分はスクロール)
  assert.match(html, /#progress-panel \{ display: none; position: absolute; top: 100%; right: 0;/);
  assert.match(html, /width: min\(520px, 90vw\); max-width: 520px; max-height: 60vh;/);
  assert.match(html, /overflow-x: hidden; overflow-y: auto;/); // 縦スクロール(横は出さない)
});

test("UI: パネルの行はellipsisで1行に収め、title属性で全文をホバー表示する", () => {
  assert.match(html, /\.pc-id \{ font-family: var\(--font-mono\); color: var\(--accent\); flex-shrink: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(html, /\.pc-sum \{ color: var\(--sub\); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(html, /\.pc-ag \{ color: var\(--label-tertiary\); flex-shrink: 0; font-size: 11px; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(html, /i\.title = id;/); // タスクidの全文をホバーで
  assert.match(html, /m\.title = sum;/); // 要約の全文をホバーで
  assert.match(html, /a\.title = ag;/); // 担当者の全文をホバーで
});

test("UI: 進捗チップはSSE更新で即時再描画される(refreshSoon経路に乗る)", () => {
  // renderAllはSSE refreshSoonの再描画から呼ばれ、syncProgressChipはその中で呼ばれる
  const ra = html.indexOf("function renderAll() {");
  const sp = html.indexOf("syncProgressChip(lastState);");
  assert.ok(ra >= 0 && sp > ra, "renderAll内でsyncProgressChipが呼ばれる");
});

// SSE(task.created/claimed/finished/merge.completed)→refreshSoon→refresh→renderAll→syncProgressChip
// の鎖を静的に固定する(チップがイベントで即時更新される構造の担保)。
test("UI: 進捗チップはSSE 4イベントからrefreshSoon→refresh→renderAll→syncProgressChipの鎖で更新される", () => {
  for (const ev of ["task.created", "task.claimed", "task.finished", "merge.completed"]) {
    assert.ok(html.includes(`"${ev}"`), `SSEハンドラに${ev}が無い`);
  }
  // refreshSoon(デバウンス)がrefresh()を呼ぶ
  const rs = html.indexOf("function refreshSoon() {");
  assert.ok(rs >= 0, "refreshSoon定義が無い");
  assert.match(html.slice(rs, rs + 200), /refresh\(\)/, "refreshSoon内でrefresh()が呼ばれない");
  // refresh()がlastStateを取り直してrenderAllする
  const rf = html.indexOf("async function refresh() {");
  assert.ok(rf >= 0, "refresh定義が無い");
  assert.match(html.slice(rf, rf + 300), /lastState = await/, "refreshがlastStateを更新しない");
  assert.match(html.slice(rf, rf + 400), /renderAll\(\)/, "refreshがrenderAllを呼ばない");
  // renderAllがsyncProgressChipを呼ぶ(既存テストの補完: 位置関係は上のテストで担保済み)
});
