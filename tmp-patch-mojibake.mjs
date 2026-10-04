// 文字化け入力の検知関数群(イシュー#20 提案3)をchat.jsへ追加するパッチ。
// CRLFファイルなのでnodeスクリプトで安全に挿入する(バッククォート・ドル波括弧は使わない)
import { readFileSync, writeFileSync } from "node:fs";
const p = "src/engine/chat.js";
let text = readFileSync(p, "utf8");
const CR = String.fromCharCode(13);

const anchor = "// ユーザー入力: 全メインを時間差で起こす(同時だと議論にならないため)。";
if (!text.includes(anchor)) throw new Error("anchor not found");
if (text.includes("containsReplacementChar")) throw new Error("already patched");

const block = [
  "// ---- 文字化け入力の検知(イシュー#20 提案3) ----",
  "// U+FFFD(置換文字)を含む入力=デコード失敗の証拠。内容を信用できない。",
  "/**",
  " * 入力にU+FFFD(replacement character)が含まれるか。",
  " * @param {string} text",
  " * @returns {boolean}",
  " */",
  "export function containsReplacementChar(text) {",
  "  return typeof text === \"string\" && text.includes(String.fromCharCode(0xfffd));",
  "}",
  "",
  "// UTF-8→cp932(等のレガシー文字コード)二重エンコードの兆候。",
  "// 置換文字が現れない化け(「ã\\u0081\\u0093…」型や「ÆüËÜ…」型)も内容として信用できない。",
  "const MOJIBAKE_PATTERNS = [",
  "  /[\\u00c0-\\u00ff][\\u0080-\\u00ff]{2}/, // ラテン拡張+制御域の連続(UTF-8バイト列がlatin1再解読された型)",
  "  /[\\u0080-\\u009f]{2,}/, // 制御領域(C1)の連続=バイト列の再解読痕",
  "];",
  "/**",
  " * 二重エンコードの兆候(化け型)か。日本語・英語の正常文では誤検知しない範囲で保守的に。",
  " * @param {string} text",
  " * @returns {boolean}",
  " */",
  "export function looksDoubleEncoded(text) {",
  "  if (typeof text !== \"string\" || text.length === 0) return false;",
  "  return MOJIBAKE_PATTERNS.some((re) => re.test(text));",
  "}",
  "",
  "/**",
  " * 化け入力を検知したときにリーダーへ注入する警告文。型(UTF-8→cp932の兆候)も伝える。",
  " * @param {string} text ユーザー入力(そのまま)",
  " * @returns {string|null} 警告文。正常入力ならnull",
  " */",
  "export function mojibakeWarning(text) {",
  "  if (containsReplacementChar(text)) {",
  "    return \"[警告] ユーザー入力に置換文字(U+FFFD)が含まれています。入力が壊れていて読めません。推測で応答せず、ユーザーに文面の再送を求めてください。\";",
  "  }",
  "  if (looksDoubleEncoded(text)) {",
  "    return \"[警告] ユーザー入力が文字化けしている可能性が高い(UTF-8→cp932二重エンコードの兆候)。入力が壊れていて読めません。推測で応答せず、ユーザーに文面の再送を求めてください。\";",
  "  }",
  "  return null;",
  "}",
].map((l) => l + CR).join("\n") + CR + CR;

text = text.replace(anchor, block + anchor);
writeFileSync(p, text);
console.log("detection functions inserted");
