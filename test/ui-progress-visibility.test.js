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

test("UI: 進捗チップのクリックでパネル(作業中一覧+直近完了10件)が出る", () => {
  assert.match(html, /function renderProgressPanel\(\) \{/);
  assert.match(html, /\[\.\.\.l\.done\]\.reverse\(\)\.slice\(0, 10\)/);
  assert.match(html, /\$\("progress-chip"\)\.onclick/);
});

test("UI: 進捗チップはSSE更新で即時再描画される(refreshSoon経路に乗る)", () => {
  // renderAllはSSE refreshSoonの再描画から呼ばれ、syncProgressChipはその中で呼ばれる
  const ra = html.indexOf("function renderAll() {");
  const sp = html.indexOf("syncProgressChip(lastState);");
  assert.ok(ra >= 0 && sp > ra, "renderAll内でsyncProgressChipが呼ばれる");
});
