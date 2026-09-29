// tmp-fix-msel-merge2.mjs — テストファイルの競合解消(HEAD側=自分のテスト5件を採用)。目的達成後に削除
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

const n = resolveConflicts("test/model-task-select.test.js", "head");
console.log("resolved:", n);
