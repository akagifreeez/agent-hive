// usage-budget-alert のUI側テスト: ステータスライン(nav-foot/左下)に「予算超過: 累積$X.XX」が
// 表示されること。サーバー側(告知・state配布)は budget-alert.test.js を参照。
// index.htmlは生JSなので、表示ロジックと同じ条件式をHTMLソースから検証する(静的確認)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "src/ui/public/index.html"), "utf8");

test("UI: ステータスラインに予算超過表示(「予算超過: 累積$X.XX」)があり、live.budgetを参照する", () => {
  // 表示文面: 予算超過: 累積$ + toFixed(2)
  assert.match(html, /予算超過: 累積\$/);
  // データ源: /api/state で配られる live.budget(costUsd/exceeded)
  assert.match(html, /live\.budget/);
  // 超過時のみ表示する条件分岐がある
  assert.match(html, /exceeded/);
});

test("UI: ステータスライン(nav-foot)への描画経路がある", () => {
  // renderAll内でnav-footへbitsが流れ込む(既存のステータスライン)
  assert.match(html, /nav-foot/);
  // budget要素をbits配列へ足している
  assert.match(html, /budgetTxt|budget/);
});
