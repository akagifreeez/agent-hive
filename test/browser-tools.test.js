// browser-new: src/engine/browser.js に追加したHTTPレベルの軽量内蔵ブラウザ操作の検証。
// 外部サイトへ実アクセスしない(node:httpのローカルサーバーで検証)。
// 形式テスト(parsePage/extrForm/applyForm系)と結合テスト(browserFetch→抽出→送信)を分ける。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  parsePage,
  extractElements,
  extractText,
  normalizeUrl,
  extractForm,
  applyFormValues,
  buildSubmission,
  browserFetch,
  browserExtract,
  browserSubmit,
} from "../src/engine/browser.js";

const PAGE_HTML = `<!doctype html>
<html>
<head><title>フォームページ</title></head>
<body>
  <h1>見出しH1</h1>
  <h2>見出しH2</h2>
  <nav>
    <a href="/docs/guide.html">ガイド</a>
    <a href="https://example.com/ext">外部リンク</a>
    <a href="#sec-1">ページ内</a>
  </nav>
  <p>これは1段落目のテキストです。</p>
  <form method="post" action="/login">
    <input type="hidden" name="csrf" value="tok-123">
    <input type="text" name="user" value="">
    <input type="password" name="pass" value="">
    <select name="role"><option value="admin">管理者</option><option value="viewer" selected>閲覧者</option></select>
    <input type="checkbox" name="save" value="on">
    <input type="submit" value="送信する">
  </form>
</body>
</html>`;

/** ローカル検証サーバー。routes: { "/path": { status?, contentType?, body, echoMethod?, redirect? } } */
function startLocalServer(routes) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const route = routes[req.url] ?? {}; console.log("SRV:", req.method, req.url);
      if (route.seeOther) {
        res.writeHead(303, { location: route.seeOther });
        res.end();
        return;
      }
      res.writeHead(route.status ?? 200, { "content-type": route.contentType ?? "text/html; charset=utf-8" });
      const echo = route.echoBody
        ? PAGE_HTML.replace("__METHOD__", req.method).replace("__BODY__", body).replace("__CT__", req.headers["content-type"] ?? "(none)")
        : route.body ?? "";
      console.log("SRV-echo len:", (echo??"").length, "bodyLen:", (route.body??"").length); res.end(echo);
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("normalizeUrl: base結合と断片排除", async (t) => {
  const base = "http://127.0.0.1:9/a/b/index.html";
  assert.equal(normalizeUrl("/docs/x.html", base), "http://127.0.0.1:9/docs/x.html");
  assert.equal(normalizeUrl("c.html", base), "http://127.0.0.1:9/a/b/c.html");
  assert.equal(normalizeUrl("//other.example/p", base), "http://other.example/p");
  assert.equal(normalizeUrl("#loc", base), null);
  assert.equal(normalizeUrl("javascript:alert(1)", base), null);
});

test("parsePage: タイトルと見出し・アンカーが取れ、script/styleは除外される", async (t) => {
  const page = parsePage(PAGE_HTML, "http://127.0.0.1:9/login.html");
  assert.equal(page.title, "フォームページ");
  assert.deepEqual(page.headings, ["見出しH1", "見出しH2"]);
  assert.equal(page.links.find((l) => l.text === "ガイド").href, "http://127.0.0.1:9/docs/guide.html");
  assert.equal(page.links.find((l) => l.text === "外部リンク").href, "https://example.com/ext");
  assert.ok(!page.links.some((l) => l.href === null)); // javascript:/断片は除外
  assert.ok(!page.text.includes("script_secret"));
});

test("parsePage: 本文テキストが整形される(タグ除去・空白潰し・行制限)", async (t) => {
  const page = parsePage(PAGE_HTML, "http://127.0.0.1:9/x.html");
  assert.ok(page.text.includes("これは1段落目のテキストです。"));
  assert.ok(!/<[a-z]/.test(page.text)); // タグ残骸がない
  assert.ok(page.text.split("\n").length <= 200);
  // 大量行も先頭200行に丸められる(過大文字列で固まらない)
  const big = parsePage(Array.from({ length: 1000 }, (_, i) => `<p>行${i}</p>`).join("\n"), "http://x/");
  assert.equal(big.text.split("\n").length, 200);
});

test("extractElements: 種別フィルタとジャンプ先(index)が返る", async (t) => {
  const page = parsePage(PAGE_HTML, "http://127.0.0.1:9/login.html");
  const forms = extractElements(page, { type: "form" });
  assert.equal(forms.length, 1);
  assert.equal(forms[0].index, 1);
  assert.equal(forms[0].action, "http://127.0.0.1:9/login");
  assert.equal(forms[0].method, "post");

  const headings = extractElements(page, { type: "heading" });
  assert.equal(headings.length, 2);
  assert.equal(headings[0].level, 1);

  const links = extractElements(page, { type: "link" });
  assert.equal(links.length, 2); // 断片(#sec-1)はnormalizeUrlで除外
  assert.ok(links.every((l) => l.index >= 1));

  const all = extractElements(page, {});
  assert.equal(all.length, 5); // リンク2+フォーム1+見出し2(断片リンクは除外)
});

test("extractText: セレクタ指定で部分テキスト抽出", async (t) => {
  const page = parsePage(PAGE_HTML, "http://127.0.0.1:9/x.html");
  const h1 = extractText(page, "h1");
  assert.ok(h1.includes("見出しH1"));
  assert.ok(!h1.includes("見出しH2"));
  assert.equal(extractText(page, null), page.text);
  assert.equal(extractText(page, "nosuchtag"), "一致する要素がありません(セレクタ: nosuchtag)");
});

test("extractForm: form_index無指定で最初のフォーム、orderは1始まり", async (t) => {
  const form = extractForm(PAGE_HTML, "http://127.0.0.1:9/login.html", null);
  assert.equal(form.method, "post");
  assert.equal(form.action, "http://127.0.0.1:9/login");
  assert.deepEqual(form.fields.map((f) => f.name), ["csrf", "user", "pass", "role", "save"]);
  assert.equal(form.fields.find((f) => f.name === "csrf").value, "tok-123");
  assert.equal(form.fields.find((f) => f.name === "role").value, "viewer");
  assert.equal(form.fields.find((f) => f.name === "user").order, 2); // csrf(hidden)含む通し番号
  assert.ok(extractForm(PAGE_HTML, "http://127.0.0.1:9/x.html", 2) === null);
});

test("applyFormValues: フォーム値の上書きと新規項目の追加順", async (t) => {
  const form = extractForm(PAGE_HTML, "http://x/", null);
  const applied = applyFormValues(form, { user: "alice", pass: "s3cret", save: true, extra: "e1" });
  assert.equal(applied.fields.find((f) => f.name === "user").value, "alice");
  assert.equal(applied.fields.find((f) => f.name === "pass").value, "s3cret");
  assert.equal(applied.fields.find((f) => f.name === "csrf").value, "tok-123"); // hiddenは温存
  assert.equal(applied.fields.find((f) => f.name === "role").value, "viewer"); // 未指定はselected維持
  assert.equal(applied.fields.find((f) => f.name === "save").value, "on"); // checkboxはvalue属性
  const names = applied.fields.map((f) => f.name);
  assert.deepEqual(names.slice(-1), ["extra"]); // 新規は末尾追加
});

test("buildSubmission: method/url/body/content-typeを組み立て(GETはクエリ結合・セレクタ検証付き)", async (t) => {
  const form = extractForm(PAGE_HTML, "http://127.0.0.1:9/login.html", null);
  const post = buildSubmission(form, { user: "alice", pass: "pw" });
  assert.equal(post.method, "POST");
  assert.equal(post.url, "http://127.0.0.1:9/login");
  assert.match(post.headers["content-type"], /^application\/x-www-form-urlencoded/);
  assert.match(post.body, /user=alice/);
  assert.match(post.body, /csrf=tok-123/); // hidden含めて送る

  const page = parsePage(`<form method="get" action="/search"><input name="q" value=""></form>`, "http://127.0.0.1:9/");
  const get = buildSubmission(extractForm(page.raw, "http://127.0.0.1:9/", null), { q: "hive" }); // page.raw=元HTML
  assert.equal(get.method, "GET");
  assert.equal(get.url, "http://127.0.0.1:9/search?q=hive");
  assert.equal(get.body, null);

  // セレクタ検証: 指定要素がフォーム内に無ければ送らない(誤送信防止)
  assert.throws(() => buildSubmission(form, {}, { selector: "nosuch" }), /が見つかりません/);
  assert.doesNotThrow(() => buildSubmission(form, {}, { selector: "user" }));
});

test("browserFetch: ローカルサーバーからGETし、page+rawが返る(絶対URL必須)", async (t) => {
  const { server, base } = await startLocalServer({ "/page.html": { body: PAGE_HTML } });
  const r = await browserFetch(`${base}/page.html`);
  assert.equal(r.ok, true);
  assert.equal(r.page.title, "フォームページ");
  assert.ok(r.status === 200);
  assert.ok(String(r.raw).includes("見出しH1"));

  const bad = await browserFetch("/relative-only.html");
  assert.equal(bad.ok, false);
  assert.match(bad.text, /http/);
  server.close();
});

test("browserExtract: 取得→抽出が1呼び出しで通る(url+selector)", async (t) => {
  const { server, base } = await startLocalServer({ "/page.html": { body: PAGE_HTML } });
  const r = await browserExtract({ url: `${base}/page.html`, selector: "h1" });
  assert.equal(r.ok, true);
  assert.match(r.text, /見出しH1/);
  server.close();
});

test("browserSubmit: POSTでフォーム送信でき、303はlocation追従して取れる", async (t) => {
  const { server, base } = await startLocalServer({
    "/login": { echoBody: true, contentType: "text/html; charset=utf-8" },
  });
  const r = await browserSubmit({
    html: PAGE_HTML,
    base_url: `${base}/login.html`,
    values: { user: "alice", pass: "s3cret" },
  });
  assert.equal(r.ok, true);
  assert.match(r.text, /^送信: POST/m); // 送信: POST <url>
  assert.match(r.text, /user=alice/);
  assert.match(r.text, /alice/); // 応答ページの抽出にも反映されている
  server.close();
});

test("browserSubmit: 303 See Other はlocationへ追従して最終応答を返す", async (t) => {
  const { server, base } = await startLocalServer({
    "/login": { seeOther: "/done.html" },
    "/done.html": { body: "<h1>完了</h1>" },
  });
  const r = await browserSubmit({ html: PAGE_HTML, base_url: `${base}/login.html`, values: { user: "x" } });
  assert.equal(r.ok, true);
  assert.match(r.text, /完了/);
  server.close();
});

test("browserSubmit: セレクタ一致なし・フォームなしは送信しない", async (t) => {
  const { server, base } = await startLocalServer({ "/login": { echoBody: true } });
  const noSel = await browserSubmit({ html: PAGE_HTML, base_url: `${base}/`, values: {}, selector: "nosuch" });
  assert.equal(noSel.ok, false);
  assert.match(noSel.text, /nosuch/);

  const noForm = await browserSubmit({ html: "<p>フォーム無し</p>", base_url: `${base}/`, values: {} });
  assert.equal(noForm.ok, false);
  assert.match(noForm.text, /フォーム/);
  server.close();
});
