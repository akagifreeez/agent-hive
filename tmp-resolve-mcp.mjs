import { readFileSync, writeFileSync } from "node:fs";

function resolveConflicts(path, pick) {
  const src = readFileSync(path, "utf8");
  const nl = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(nl);
  const norm = (s) => s.replace(/\r$/, "");
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const b = norm(lines[i]);
    if (b.startsWith("<<<<<<<") || b === "=======" || b.startsWith(">>>>>>>")) marks.push({ type: b.startsWith("<<<<<<<") ? "start" : b === "=======" ? "mid" : "end", i });
  }
  if (marks.length === 0) { console.log(path + ": no conflicts"); return 0; }
  const starts = marks.filter((m) => m.type === "start");
  let resolved = 0;
  for (let k = starts.length - 1; k >= 0; k--) {
    const startI = starts[k].i;
    const midI = marks.find((m) => m.type === "mid" && m.i > startI).i;
    const endI = marks.find((m) => m.type === "end" && m.i > midI).i;
    const head = lines.slice(startI + 1, midI);
    const main = lines.slice(midI + 1, endI);
    const chosen = pick(head, main, norm(lines[startI]), norm(lines[endI]));
    lines.splice(startI, endI - startI + 1, ...chosen);
    resolved++;
  }
  writeFileSync(path, lines.join(nl));
  console.log(path + ": resolved " + resolved + " conflicts");
  return resolved;
}

// mcp.js: main側(現行mainの#27契約: childError/connected/即reject)をベースに採用。
// HEAD側は古い設計(spawnError/this.child=null)。テスト契約はmain側に一致する。
resolveConflicts("src/engine/mcp.js", (head, main) => main);

// test/mcp.test.js: main側(現行mainのテスト契約)を採用
resolveConflicts("test/mcp.test.js", (head, main) => main);
