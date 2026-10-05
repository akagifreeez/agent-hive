// fix-24: permissions.js のconfirm判定を複合コマンドの各実行単位へ拡張するパッチ
// 注意: このスクリプト内ではテンプレートリテラルと${}を一切使わない(記憶の教訓)
import fs from "node:fs";
const p = "src/engine/permissions.js";
let s = fs.readFileSync(p, "utf8");
const NL = "\r\n"; // 対象はCRLF
const LF = "\n";

// --- 修正1: splitExecUnits 関数を normalizeConfirmArgv の後に追加 ---
const anchorA = "  return out.join(\" \");" + NL + "}" + NL;
if (!s.includes(anchorA)) { console.error("ANCHOR A NOT FOUND"); process.exit(1); }
const addA = [
  "",
  "",
  "// \u30b7\u30a7\u30eb\u306e\u5b9f\u884c\u5358\u4f4d\u3078\u306e\u5206\u5272: \u8907\u5408\u30b3\u30de\u30f3\u30c9(; && || | \u6539\u884c)\u3092\u5b9f\u884c\u5358\u4f4d\u3054\u3068\u306b\u5207\u308b\u3002",
  "// \u30af\u30a9\u30fc\u30c8\u5185\u306e\u533a\u5207\u308a\u306f\u8003\u616e\u3057\u306a\u3044(\u904e\u5270\u5206\u5272\u306f\u300c\u627f\u8a8d\u8981\u6c42\u304c\u5897\u3048\u308b\u300d\u5b89\u5168\u5074\u306b\u5012\u308c\u308b\u305f\u3081\u3001confirm\u5224\u5b9a\u306b\u306f\u5341\u5206)\u3002",
  "// \u7a7a\u306e\u5358\u4f4d(\u8fd1\u63a5\u3059\u308b\u533a\u5207\u308a\u5b50\u7b49)\u306f\u6368\u3066\u308b\u3002",
  "export function splitExecUnits(cmd) {",
  "  return String(cmd ?? \"\")",
  "    .split(/(;|&&|\\|\\||\\||\\r?\\n)/)",
  "    .filter((u) => u != null && !/^(;|&&|\\|\\||\\||\\r?\\n)$/.test(u))",
  "    .map((u) => u.trim())",
  "    .filter(Boolean);",
  "}",
  ""
].join(LF);
const idxA = s.indexOf(anchorA) + anchorA.length;
s = s.slice(0, idxA) + addA.replace(/\n/g, NL) + s.slice(idxA);

// --- 修正2: check() \u5185\u306econfirm\u5224\u5b9a\u3092\u5168\u5b9f\u884c\u5358\u4f4d\u5bfe\u8c61\u306b\u62e1\u5f35 ---
const oldB = [
  "    const argv = normalizeConfirmArgv(command);",
  "    const argvTokens = argv.split(\" \");",
  "    const hitConfirm = this.confirm.find((p) => {",
  "      // \u5148\u982d\u30c8\u30fc\u30af\u30f3\u4e00\u81f4(\u90e8\u5206\u4e00\u81f4\u306e\u8aa4\u7206\u300cecho killing\u300d\u7b49\u3092\u907f\u3051\u308b)\u3002\u8907\u6570\u8a9e\u30d1\u30bf\u30fc\u30f3\u306f\u524d\u7f6e\u8a9e\u4e00\u81f4",
  "      const pt = String(p).trim().split(/\\s+/);",
  "      return pt.every((w, i) => argvTokens[i] === w);",
  "    });"
].join(NL);
const newB = [
  "    // \u8907\u5408\u30b3\u30de\u30f3\u30c9\u5bfe\u5fdc: \u5b9f\u884c\u5358\u4f4d\u3054\u3068\u306bconfirm\u5224\u5b9a\u3057\u3001",
  "    // 1\u3064\u3067\u3082confirm\u5fc5\u9808\u304c\u3042\u308c\u3070\u5168\u4f53\u3092\u627f\u8a8d\u8981\u6c42\u6271\u3044\u306b\u3059\u308b(\u30a4\u30b7\u30e5\u30fc#24)\u3002",
  "    // \u300cecho ready; curl ...\u300d\u306e2\u756a\u76ee\u4ee5\u964d\u306e\u5358\u4f4d\u3067\u3082\u7d20\u901a\u308a\u3055\u305b\u306a\u3044\u3002",
  "    const hitConfirm = splitExecUnits(command).map((unit) => normalizeConfirmArgv(unit)).find((argv) =>",
  "      this.confirm.find((p) => {",
  "        // \u5148\u982d\u30c8\u30fc\u30af\u30f3\u4e00\u81f4(\u90e8\u5206\u4e00\u81f4\u306e\u8aa4\u7206\u300cecho killing\u300d\u7b49\u3092\u907f\u3051\u308b)\u3002\u8907\u6570\u8a9e\u30d1\u30bf\u30fc\u30f3\u306f\u524d\u7f6e\u8a9e\u4e00\u81f4",
  "        const argvTokens = argv.split(\" \");",
  "        const pt = String(p).trim().split(/\\s+/);",
  "        return pt.every((w, i) => argvTokens[i] === w);",
  "      })",
  "    );"
].join(NL);
if (!s.includes(oldB)) { console.error("ANCHOR B NOT FOUND"); process.exit(1); }
s = s.replace(oldB, newB);

fs.writeFileSync(p, s);
console.log("patched OK");
