// ボード用マークダウン描画器の検証(ブラウザ相当のグローバルで評価)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const code = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "public", "markdown.js"),
  "utf8",
);
const renderMarkdown = new Function(code + "\n;return renderMarkdown;")();

test("フェンスコードはエスケープされてpre/codeになる", () => {
  const out = renderMarkdown("```js\nconst a = '<b>';\n```");
  assert.match(out, /<pre><code>/);
  assert.match(out, /&lt;b&gt;/);
  assert.ok(!out.includes("<b>"));
});

test("太字・インラインコード・打ち消し", () => {
  const out = renderMarkdown("**重要**と`code`と~~削除~~");
  assert.match(out, /<strong>重要<\/strong>/);
  assert.match(out, /<code>code<\/code>/);
  assert.match(out, /<del>削除<\/del>/);
});

test("見出しとリスト(入れ子)", () => {
  const out = renderMarkdown("## 見出し\n- 項目A\n  - 子A\n- 項目B\n");
  assert.match(out, /<h2>見出し<\/h2>/);
  assert.match(out, /<ul><li>項目A<ul><li>子A<\/li><\/ul><\/li><li>項目B<\/li><\/ul>/);
});

test("表とリンク(http(s)のみ)", () => {
  const out = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.match(out, /<th>A<\/th>/);
  assert.match(out, /<td>1<\/td>/);
  const out2 = renderMarkdown("[例](https://example.com)と[悪](javascript:alert(1))");
  assert.match(out2, /<a href="https:\/\/example\.com"/);
  assert.ok(!out2.includes('href="javascript'));
});

test("HTMLはエスケープされ属性注入も不能", () => {
  const out = renderMarkdown('<img src=x onerror=alert(1)>**太字**');
  assert.ok(!out.includes("<img"));
  assert.match(out, /&lt;img/);
  assert.match(out, /<strong>太字<\/strong>/);
});
