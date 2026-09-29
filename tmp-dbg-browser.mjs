import { parsePage, extractElements, extractForm, buildSubmission, browserFetch } from "./src/engine/browser.js";
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
const page = parsePage(PAGE_HTML, "http://127.0.0.1:9/login.html");
console.log("links:", JSON.stringify(page.links));
console.log("forms:", JSON.stringify(page.forms, null, 1));
const links = extractElements(page, { type: "link" });
console.log("link count:", links.length);
const form = extractForm(PAGE_HTML, "http://127.0.0.1:9/login.html", null);
console.log("form fields:", JSON.stringify(form?.fields?.map(f=>f.name)), "method:", form?.method);
