// fix-browser-tools-impl: 実装+テストの仕様整合パッチ(CRLF安全化のためnodeで適用)。
// バッククォートとドル波括弧はこのスクリプト内に書かない(テンプレート展開防止)。
import fs from "node:fs";

const FIX = String.fromCharCode(92) + "r" + String.fromCharCode(92) + "n"; // escape for regex \r\n
const NL = String.fromCharCode(10);

function patch(path, pairs) {
  let s = fs.readFileSync(path, "utf8");
  for (const [bad, good] of pairs) {
    if (!s.includes(bad)) { console.error("ANCHOR NOT FOUND in " + path + ": " + bad.slice(0, 80)); process.exit(1); }
    s = s.replace(bad, good);
  }
  fs.writeFileSync(path, s);
  console.log("patched: " + path);
}

const T = "test/browser-tools.test.js";

// テスト側: startLocalServerの未定義第一引数tは既に除去済み(別修正で対応済み)

const B = "src/engine/browser-tools.js";

// 実装側: リンクはhref解決失敗を除外 / method小文字維持 / page.html保持
patch(B, [
  // 1) links: 解決失敗(null)は除外。テスト: !page.links.some(l => l.href === null)
  [
    "    const href = normalizeUrl(raw, base);" + NL +
    "    if (!text && !href) continue;" + NL +
    "    links.push({ text, href });",
    "    const href = normalizeUrl(raw, base);" + NL +
    "    if (!href) continue;" + NL +
    "    links.push({ text, href });",
  ],
  // 2) forms: methodはHTML表記を維持(小文字post)。正規化はbuildSubmission側で行う
  [
    "    const method = (btAttr(attrs, \"method\") || \"GET\").toUpperCase();",
    "    const method = btAttr(attrs, \"method\") || \"get\";",
  ],
  // 3) parsePage戻り値へ html: src を追加(セレクタ検証・GET結合の素材)
  [
    "  return { url: base, title, headings, links, forms, text: textLines.join(\"\\n\"), raw: src };",
    "  return { url: base, title, headings, links, forms, text: textLines.join(\"\\n\"), raw: src, html: src };",
  ],
  // 4) 戻り値JSDocにもhtmlを追記
  [
    "links: Array<{text: string, href: string|null}>, forms:",
    "links: Array<{text: string, href: string}>, forms:",
  ],
  [
    " * @returns {{url: string, title: string, headings: string[],",
    " * @returns {{url: string, title: string, headings: string[], html: string,",
  ],
]);

// buildSubmission: method正規化・GETはURL結合・セレクタ検証は属性形態対応
patch(B, [
  [
    "  const pairs = f.fields.filter((x) => x.name).map((x) => [x.name, x.value ?? \"\"]);" + NL +
    "  const body = new URLSearchParams(pairs).toString();" + NL +
    "  if ((f.method || \"GET\").toUpperCase() === \"GET\") {" + NL +
    "    const url = new URL(f.action);" + NL +
    "    url.search = body ? \"?\" + body : url.search;" + NL +
    "    return { method: \"GET\", url: url.toString(), body: null, headers: {} };" + NL +
    "  }",
    "  const pairs = f.fields.filter((x) => x.name).map((x) => [x.name, x.value ?? \"\"]);" + NL +
    "  const body = new URLSearchParams(pairs).toString();" + NL +
    "  const isGet = (f.method || \"get\").toLowerCase() === \"get\";" + NL +
    "  if (isGet) {" + NL +
    "    const url = new URL(f.action);" + NL +
    "    if (body) url.search = \"?\" + body;" + NL +
    "    return { method: \"GET\", url: url.toString(), body: null, headers: {} };" + NL +
    "  }",
  ],
  // セレクタ検証: "<user" / "<user " / "<user>" のいずれかで一致判定(属性・テキスト両対応)
  [
    "  if (opts.selector) {" + NL +
    "    const selRe = new RegExp(\"<\" + String(opts.selector) + \"(\\\\s|>)\", \"i\");" + NL +
    "    if (!selRe.test(String(form.html ?? \"\"))) throw new Error(\"フォーム内に要素 \" + String(opts.selector) + \" が見つかりません(誤送信防止のため送信しません)\");" + NL +
    "  }",
    "  if (opts.selector) {" + NL +
    "    const sel = String(opts.selector);" + NL +
    "    const openTag = new RegExp(\"<\" + sel + \"(\\\\s[^>]*|/?>)\", \"i\");" + NL +
    "    if (!openTag.test(String(form.html ?? \"\"))) throw new Error(\"フォーム内に要素 \" + sel + \" が見つかりません(誤送信防止のため送信しません)\");" + NL +
    "  }",
  ],
]);

console.log("done");
