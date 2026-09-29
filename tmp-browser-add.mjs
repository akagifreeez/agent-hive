import fs from "node:fs";
const p = "src/engine/browser.js";
const orig = fs.readFileSync(p, "utf8");
// 既存のimport行を拡張
let s = orig.replace(
  'import { spawn } from "node:child_process";',
  'import { spawn } from "node:child_process";\nimport { request as httpRequest } from "node:http";\nimport { request as httpsRequest } from "node:https";'
);
if (s === orig) { console.error("import anchor not found"); process.exit(1); }
const NL = "\n";
const add = [
"",
"// ===== HTTPレベルの軽量ブラウザ操作(test/browser-tools.test.js が仕様)。=====",
"// fetch→parsePage→(抽出/フォーム送信)をnode:http/httpsのみで行う。",
"",
"/**",
" * 相対URLをbaseと結合する。断片(#...)・javascript:等はnull(リンク一覧から除外)。",
" * @param {string} href",
" * @param {string} base",
" * @returns {string|null}",
" */",
"export function normalizeUrl(href, base) {",
"  const raw = String(href ?? \"\").trim();",
"  if (!raw) return null;",
"  if (/^(javascript|data|mailto|tel|blob):/i.test(raw)) return null;",
"  if (raw.startsWith(\"#\")) return null;",
"  try {",
"    const u = new URL(raw, base);",
"    if (u.protocol !== \"http:\" && u.protocol !== \"https:\") return null;",
"    u.hash = \"\";",
"    return u.toString();",
"  } catch {",
"    return null;",
"  }",
"}",
"",
"/** HTML実体参照を戻す(最小セット)。 */",
"function decodeEntities(s) {",
"  return s",
"    .replace(/&lt;/g, \"<\")",
"    .replace(/&gt;/g, \">\")",
"    .replace(/&quot;/g, '\"')",
"    .replace(/&#39;/g, \"'\")",
"    .replace(/&nbsp;/g, \" \")",
"    .replace(/&amp;/g, \"&\");",
"}",
"",
"/** タグ除去+空白整形(整形済みテキスト行配列)。script/style/noscript/コメントは除外。 */",
"function htmlToLines(html) {",
"  const noScript = String(html ?? \"\")",
"    .replace(/<!--[\s\S]*?-->/g, \" \")",
"    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, \" \");",
"  const withBreaks = noScript.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, \"\n\");",
"  return withBreaks",
"    .replace(/<[^>]+>/g, \" \")",
"    .split(\"\n\")",
"    .map((l) => decodeEntities(l).replace(/\s+/g, \" \").trim())",
"    .filter(Boolean);",
"}",
"",
"/** attr風の属性値を取り出す(attrName=\"...\")。 */",
"function attr(attrs, name) {",
"  const m = attrs.match(new RegExp(name + \"\\s*=\\s*(\\\"([^\\\"]*)\\\"|'([^']*)')\", \"i\"));",
"  return m ? (m[2] ?? m[3] ?? \"\") : null;",
"}",
].join(NL);
fs.writeFileSync(p, s + NL + add + NL);
console.log("part1 written");
