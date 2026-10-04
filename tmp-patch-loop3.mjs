import fs from "node:fs";
const p = "src/engine/loop.js";
let s = fs.readFileSync(p, "utf8");
const lines = s.split(/\r?\n/);
// 壊れた行(160)を探して文字列連結で組み立て直す
const badIdx = lines.findIndex((l) => l.includes("const text = fresh.map((p) =>"));
if (badIdx < 0) { console.error("anchor not found"); process.exit(1); }
const bs = String.fromCharCode(92);
const dq = String.fromCharCode(34);
const bt = String.fromCharCode(96);
const nlEsc = bs + "n"; // \n の文字列表現
// join("\n---\n") を安全に: 文字列連結で組み立て
const line = "      const text = fresh.map((p) => " + bt + "${p.from} [#" + "${p.id}" + "${p.at ? " + dq + " " + " + "String(p.at).slice(0, 16).replace(" + dq + "T" + dq + ", " + dq + " " + dq + ")" + " : " + dq + dq + "}]: ${p.text}" + bt + ").join(" + dq + nlEsc + "---" + nlEsc + dq + ");";
lines[badIdx] = line;
fs.writeFileSync(p, lines.join("\n"));
console.log("rebuilt:", line);
