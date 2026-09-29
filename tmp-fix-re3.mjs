import fs from "node:fs";
const p = "src/engine/browser-tools.js";
let s = fs.readFileSync(p, "utf8");
// ソース上は \[ (エスケープされた開き括弧)。文字クラスとしては [\s\S] で正しいので
// \[ をただの [ へ、余計な ]] を ] へ直す。対象の2行だけ行単位で組み立て直すのが確実。
const bs = String.fromCharCode(92);
const dq = String.fromCharCode(34);
const tokenPat = "<(input|select|textarea)([^>]*)(?:>(" + bs + "[" + bs + "s" + bs + "S]" + "*?)<" + bs + "/(?:input|select|textarea)" + bs + "s*>|" + bs + "s*?>)";
const optPat = "<option" + bs + "s([^>]*)>(" + bs + "[" + bs + "s" + bs + "S]" + "*?)<" + bs + "/option" + bs + "s*>";
const lines = s.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("const tokenRe = new RegExp")) {
    lines[i] = "  const tokenRe = new RegExp(" + dq + tokenPat + dq + ", " + dq + "gi" + dq + ");";
  }
  if (lines[i].includes("const optRe = new RegExp")) {
    lines[i] = "      const optRe = new RegExp(" + dq + optPat + dq + ", " + dq + "gi" + dq + ");";
  }
}
fs.writeFileSync(p, lines.join("\n"));
console.log("tokenPat:", tokenPat);
console.log("optPat:", optPat);
