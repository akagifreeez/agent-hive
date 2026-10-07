import { readFileSync, writeFileSync } from "node:fs";
const NL = String.fromCharCode(10);
const p = "src/engine/exec.js";
const lines = readFileSync(p, "utf8").split(NL);

function idxOf(includes, from = 0) {
  const i = lines.findIndex((l, k) => k >= from && l.includes(includes));
  if (i < 0) throw new Error("anchor not found: " + includes);
  return i;
}

// 1) runCommand シグネチャへ keep を追加(既定head=従来動作)
let i = idxOf("export async function runCommand({ command, cwd, timeoutMs = 30000, outputLimit = 8 * 1024, env = null }) {");
lines[i] = "export async function runCommand({ command, cwd, timeoutMs = 30000, outputLimit = 8 * 1024, env = null, keep = \"head\" }) {";

// 2) 後続への引数通し
i = idxOf("return runTestCommand({ command, cwd, timeoutMs, outputLimit, env }, runCommandInner);");
lines[i] = "  return runTestCommand({ command, cwd, timeoutMs, outputLimit, env, keep }, runCommandInner);";
i = idxOf("return runCommandInner({ command, cwd, timeoutMs, outputLimit, env });");
lines[i] = "  return runCommandInner({ command, cwd, timeoutMs, outputLimit, env, keep });";

// 3) runCommandInner 側の受け取り
i = idxOf("async function runCommandInner({ command, cwd, timeoutMs = 30000, outputLimit = 8 * 1024, env = null }) {");
lines[i] = "async function runCommandInner({ command, cwd, timeoutMs = 30000, outputLimit = 8 * 1024, env = null, keep = \"head\" }) {";

// 4) append を keep対応へ(keep=tail は末尾outputLimit分を常に保持)
i = idxOf("const append = (d) => {");
const appendBlock = [
  "  const append = (d) => {",
  "    if (keep === \"tail\") {",
  "      out += d.toString();",
  "      if (out.length > outputLimit) out = out.slice(out.length - outputLimit);",
  "    } else if (out.length < outputLimit) {",
  "      out += d.toString();",
  "    }",
  "  };",
];
lines.splice(i, 3, ...appendBlock);

// 5) JSDoc追記(runCommandの@paramブロックの直後)
i = idxOf("@param {{command: string, cwd?: string, env?: Object, outputLimit?: number, timeoutMs?: number}} o");
lines.splice(i + 1, 0, " * @param {string} [keep=\"head\"] 出力の丸め方向。\"head\"=先頭から保持(従来動作・既定)|\"tail\"=末尾を保持(テストサマリ等・失敗節が末尾に出る形式向け)");

writeFileSync(p, lines.join(NL));
console.log("patched exec.js OK");
