// 修復2c: isRetryableNetworkError の復元のみ(aは tmp-fix2b で済み)
import { readFileSync, writeFileSync } from "node:fs";
const path = "src/model/openai.js";
const raw = readFileSync(path, "utf8");
const nl = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(nl);
if (lines.some((l) => l.includes("function isRetryableNetworkError"))) {
  console.log("already restored");
} else {
  const idx = lines.findIndex((l) => l.includes("// stream系の汎用Error"));
  if (idx < 0) throw new Error("挿入点が見つかりません");
  const restore = [
    "function isRetryableNetworkError(err) {",
    "  if (!err) return false;",
    '  const code = String(err.code ?? err.cause?.code ?? "");',
    "  return ABORT_CODE_RE.test(code) || isAbortRelated(err);",
    "}",
  ];
  lines.splice(idx, 0, ...restore.map((s) => s.replace(/\n/g, nl)));
  writeFileSync(path, lines.join(nl));
  console.log("restored isRetryableNetworkError at line", idx + 1);
}
