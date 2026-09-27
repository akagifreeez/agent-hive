import { readFileSync } from "node:fs";
const s = readFileSync("src/engine/tools.js", "utf8");
const lines = s.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  let q = null, esc = false;
  for (const c of l) {
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'" || c === "`") q = c;
  }
  if (q) console.log("unclosed", q, "line", i + 1);
}