import { readFileSync, writeFileSync } from "node:fs";
let s = readFileSync("src/engine/mcp.js", "utf8");
const lines = s.split(/\r?\n/);
const out = [];
let mode = "normal"; // normal | inHead | inMain
for (const l of lines) {
  if (mode === "normal" && /^<<<<<<< /.test(l)) { mode = "inHead"; continue; }
  if (mode === "inHead" && /^=======$/.test(l.replace(/\r$/, ""))) { mode = "inMain"; continue; }
  if (mode === "inMain" && /^>>>>>>> /.test(l)) { mode = "normal"; continue; }
  if (mode === "inHead") continue; // HEAD側(空)は捨てる
  out.push(l);
}
if (mode !== "normal") { console.log("unbalanced markers, abort"); process.exit(1); }
writeFileSync("src/engine/mcp.js", out.join("\n"));
console.log("resolved, lines:", out.length);