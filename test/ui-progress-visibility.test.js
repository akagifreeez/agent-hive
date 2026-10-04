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
