import { readFileSync, writeFileSync } from "node:fs";

// Fix 1: browser-tools.js extractElements link branch -> restore 972122c (page.links only)
let a = readFileSync("src/engine/browser-tools.js", "utf8");
const bad1 = 'for (const l of [...(page.links ?? []), ...(page.anchors ?? [])]) out.push({ index: ++index, type, text: l.text, href: l.href });';
const eol = a.includes("\r\n") ? "\r\n" : "\n";
const good1 = [
  '// リンクはpage.linksを使う(parsePageと同じ一覧。断片#/javascript:は除外済み・テスト仕様 e80e512)',
  'for (const l of page.links ?? []) {',
  '  if (index >= 100) break;',
  '  out.push({ index: ++index, type, text: l.text, href: l.href });',
  '}',
].join(eol);
if (!a.includes(bad1)) { console.error("PATTERN1 NOT FOUND"); process.exit(1); }
a = a.replace(bad1, good1);
writeFileSync("src/engine/browser-tools.js", a);

// Fix 2: test/browser-tools.test.js call sites: startLocalServer(t, { -> startLocalServer({  (restore b17357d)
let b = readFileSync("test/browser-tools.test.js", "utf8");
const bad2 = "startLocalServer(t, {";
const good2 = "startLocalServer({";
const n = b.split(bad2).length - 1;
if (n !== 5) { console.error("PATTERN2 COUNT=" + n + " (expect 5)"); process.exit(1); }
b = b.split(bad2).join(good2);
writeFileSync("test/browser-tools.test.js", b);
console.log("PATCH OK");
