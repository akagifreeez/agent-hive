// tmp-fix-msel-merge.mjs — model-task-select のマージ競合を解消(main側を採用+HEADの同等実装は削除)。目的達成後に削除
import { readFileSync, writeFileSync } from "node:fs";

function resolveConflicts(p, pick) {
  let s = readFileSync(p, "utf8");
  const LF = String.fromCharCode(10);
  const lines = s.split(LF);
  const out = [];
  let i = 0;
  let resolved = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.replace(/\r$/, "").startsWith("<<<<<<<")) {
      // ブロック解析
      let j = i + 1;
      const head = [];
      let mid = -1;
      while (j < lines.length) {
        const t = lines[j].replace(/\r$/, "");
        if (t.startsWith("=======") && mid < 0) { mid = j; j++; continue; }
        if (t.startsWith(">>>>>>>")) break;
        if (mid < 0) head.push(lines[j]);
        j++;
      }
      // midの後~>>>>>>>の前がmain側
      const mainSide = [];
      for (let k = mid + 1; k < j; k++) mainSide.push(lines[k]);
      out.push(...(pick === "main" ? mainSide : head));
      resolved++;
      i = j + 1;
      continue;
    }
    out.push(l);
    i++;
  }
  writeFileSync(p, out.join(LF));
  return resolved;
}

const targets = [
  ["src/engine/tasks.js", "main"],
  ["src/engine/tools.js", "main"],
  ["src/engine/spawn.js", "main"],
  ["src/engine/chat.js", "main"],
  ["src/engine/loop.js", "main"],
];
for (const [p, pick] of targets) {
  const n = resolveConflicts(p, pick);
  console.log(p, "resolved:", n);
}
