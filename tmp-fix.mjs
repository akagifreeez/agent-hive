import { readFileSync, writeFileSync } from "node:fs";
let s = readFileSync("src/engine/tools.js", "utf8");
const before = s;
// 行355-357: (warn ? "<CRLF><CRLF>" + warn : "")
s = s.replace(/\(warn \? "\r?\n\r?\n" \+ warn : ""\)/, '(warn ? "\\n\\n" + warn : "")');
writeFileSync("src/engine/tools.js", s);
console.log("changed:", before !== s);