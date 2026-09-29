// 一時パッチスクリプト(実行後自己削除): tools.js の specs へ browser_* 3ツールを再追加。
// 前回追加したspecsがラウンド自動マージ(a75ec61)で消失したため復元する。
// anchor: web_search spec の直前に挿入。
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
const p = "src/engine/tools.js";
let src = readFileSync(p, "utf8");
if (src.includes('name: "browser_fetch"')) { console.log("specsは既に存在"); unlinkSync("tmp-add-browser-specs-beta.mjs"); process.exit(0); }
const anchor = [
  "    {",
  "      name: \"web_search\",",
].join("\n");
if (!src.includes(anchor)) { console.error("anchor不在"); process.exit(1); }
const specs = [
  "    {",
  "      name: \"browser_fetch\",",
  "      description: \"指定URLのページを取得し、構造化結果(タイトル/見出し/リンク/フォーム/本文テキスト)とrawを返す。urlはhttp(s)の絶対URL必須。\",",
  "      parameters: {",
  "        type: \"object\",",
  "        properties: {",
  "          url: { type: \"string\", description: \"取得するURL(絶対URL)\" },",
  "        },",
  "        required: [\"url\"],",
  "        additionalProperties: false,",
  "      },",
  "    },",
  "    {",
  "      name: \"browser_extract\",",
  "      description: \"URL取得またはHTML直指定からセレクタで部分テキストを抽出する。urlとhtmlはどちらか必須。\",",
  "      parameters: {",
  "        type: \"object\",",
  "        properties: {",
  "          url: { type: \"string\", description: \"取得するURL(絶対URL)。html指定時は省略可\" },",
  "          html: { type: \"string\", description: \"直接解析するHTML(url省略時に使う)\" },",
  "          selector: { type: \"string\", description: \"抽出する要素(例: h1、#id)。省略時は本文全体\" },",
  "        },",
  "        additionalProperties: false,",
  "      },",
  "    },",
  "    {",
  "      name: \"browser_submit\",",
  "      description: \"HTML内のフォームへ値を設定して送信する(GET=クエリ結合/POST=urlenc、303等はlocation追従)。selectorでフォーム内要素を検証し誤送信を防ぐ。\",",
  "      parameters: {",
  "        type: \"object\",",
  "        properties: {",
  "          html: { type: \"string\", description: \"フォームを含むHTML\" },",
  "          base_url: { type: \"string\", description: \"フォームの基準URL(絶対URL)\" },",
  "          values: { type: \"object\", description: \"設定する値(name→値のオブジェクト)\" },",
  "          selector: { type: \"string\", description: \"送信前に存在を確認するフォーム内要素(誤送信防止)\" },",
  "          follow_redirects: { type: \"boolean\", description: \"リダイレクト追従(既定true)\" },",
  "        },",
  "        required: [\"html\", \"base_url\"],",
  "        additionalProperties: false,",
  "      },",
  "    },",
].join("\n");
const out = src.replace(anchor, specs + "\n" + anchor);
writeFileSync(p, out);
unlinkSync("tmp-add-browser-specs-beta.mjs");
console.log("specs 3ツール再追加完了");
