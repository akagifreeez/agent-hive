import { readFileSync } from "node:fs";
const s = readFileSync("src/engine/loop.js", "utf8").replace(/\r\n/g, "\n");
const i = s.indexOf("      seen = fresh[fresh.length - 1].id;");
const block = s.slice(i - 40, i + 560);
// 各行をJSONエスケープで表示(不可視差分を暴く)
for (const line of block.split("\n")) console.log(JSON.stringify(line));
