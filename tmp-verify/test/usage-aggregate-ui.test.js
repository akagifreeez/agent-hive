// usage集計ビューのUI側テスト(イシュー#6): usageタブ(status)に日別・スレッド別の
// 集計表があること。サーバー側(aggregate・/api/usage)は usage-aggregate.test.js を参照。
// index.htmlは生JSなので、表示ロジックと同じ条件式をHTMLソースから検証する(静的確認)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "src/ui/public/index.html"), "utf8");

test("UI: usageタブに日別の消費集計表がある", () => {
  // /api/usage のaggregateをUIが参照している
  assert.match(html, /aggregate/);
  // 日別セクション(新しい順)の見出しとテーブルがある
  assert.match(html, /日別の消費/);
  assert.match(html, /byDate/);
});

test("UI: usageタブにスレッド別の消費集計表がある", () => {
  // スレッド別セクション(消費の大きい順)の見出しとテーブルがある
  assert.match(html, /スレッド別の消費/);
  assert.match(html, /byThread/);
});

test("UI: usage集計は集計関数(aggregateUsage)のデータに基づき、描画関数が存在する", () => {
  // 集計ビューの描画関数(renderUsageAggregate)があり、/api/usage を引く
  assert.match(html, /renderUsageAggregate/);
  assert.match(html, /hfetch\("\/api\/usage"\)/);
});
