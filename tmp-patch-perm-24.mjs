// fix-24: permissions.js のconfirm判定を複合コマンドの各実行単位へ拡張するパッチ
// 教訓適用: このスクリプトは正規表現リテラルもバックスラッシュもテンプレートリテラルも使わない
import fs from "node:fs";
const p = "src/engine/permissions.js";
let s = fs.readFileSync(p, "utf8");
const NL = String.fromCharCode(13, 10); // CRLF
const LF = String.fromCharCode(10);

// --- 修正1: splitExecUnits 関数を normalizeConfirmArgv の直後に追加(文字コードスキャン方式) ---
const anchorA = "  return out.join(\" \");" + NL + "}" + NL;
if (!s.includes(anchorA)) { console.error("ANCHOR A NOT FOUND"); process.exit(1); }
const addA = [
  "",
  "",
  "// シェルの実行単位への分割: 複合コマンド(; && & || パイプ 改行)を実行単位ごとに切る。",
  "// クォート内の区切りは考慮しない(過剰分割は「承認要求が増える」安全側に倒れるため、confirm判定には十分)。",
  "// 正規表現を使わず文字コードで走査する(59=';' 38='&' 124='|' 10=LF 13=CR)。",
  "export function splitExecUnits(cmd) {",
  "  const text = String(cmd ?? \"\");",
  "  const units = [];",
  "  let cur = \"\";",
  "  for (let i = 0; i < text.length; i++) {",
  "    const c = text.charCodeAt(i);",
  "    if (c === 59 || c === 38 || c === 124 || c === 10 || c === 13) {",
  "      units.push(cur);",
  "      cur = \"\";",
  "      continue;",
  "    }",
  "    cur += text[i];",
  "  }",
  "  units.push(cur);",
  "  return units.map((u) => u.trim()).filter(Boolean);",
  "}",
  ""
].join(LF);
const idxA = s.indexOf(anchorA) + anchorA.length;
s = s.slice(0, idxA) + addA.split(LF).join(NL) + s.slice(idxA);

// --- 修正2: check() 内のconfirm判定を実行単位ごとへ拡張 ---
// 旧ブロックは正規表現リテラル(/の内部)を含むため、行番号ベースで特定する。
const startMark = "    const argv = normalizeConfirmArgv(command);";
const endMark = "    if (hitConfirm) {";
const i0 = s.indexOf(startMark);
const i1 = s.indexOf(endMark, i0);
if (i0 < 0 || i1 < 0) { console.error("ANCHOR B NOT FOUND"); process.exit(1); }
const newB = [
  "    // 複合コマンド対応: 実行単位ごとにconfirm判定し、",
  "    // 1つでもconfirm必須があれば全体を承認要求扱いにする(イシュー#24)。",
  "    // 「echo ready; curl ...」の2番目以降の単位でも素通りさせない。",
  "    const hitConfirm = splitExecUnits(command).map((unit) => normalizeConfirmArgv(unit)).find((argv) =>",
  "      this.confirm.find((p) => {",
  "        // 先頭トークン一致(部分一致の誤爆「echo killing」等を避ける)。複数語パターンは前置詞一致",
  "        const argvTokens = argv.split(\" \");",
  "        const pt = normalizeCommand(String(p).trim());",
  "        return pt.split(\" \").every((w, i) => argvTokens[i] === w);",
  "      })",
  "    );",
  ""
].join(LF).split(LF).join(NL);
s = s.slice(0, i0) + newB + s.slice(i1);

fs.writeFileSync(p, s);
console.log("patched OK");
