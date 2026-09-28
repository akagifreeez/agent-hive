import { readFileSync, writeFileSync } from "node:fs";

// fix-test-failures: /api/mcp が未知のop(op: bogus)でもonMcpRemove経由で200を返す不具合。
// server.js側で op を検証して unknown op は400を返すのが正しい(API契約: opはadd|removeのみ)。
const f = "src/ui/server.js";
let s = readFileSync(f, "utf8");
const lines = s.split("\n");

let at = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const r = op === "add" ? await onMcpAdd(rest) : onMcpRemove(rest);')) { at = i; break; }
}
if (at < 0) throw new Error("mcp op dispatch line not found");

// 未知opはハンドラへ届けず400。テスト(mcp-settings.test.js)の契約どおり。
lines[at] = '            if (op !== "add" && op !== "remove") throw new Error("不明なop: " + String(op));\n            const r = op === "add" ? await onMcpAdd(rest) : onMcpRemove(rest);';

writeFileSync(f, lines.join("\n"));
console.log("patched /api/mcp op validation at line", at + 1);
