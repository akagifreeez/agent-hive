// fix-browser-tools-impl 追加パッチ2: CRLF行(\r\n)対応の行単位置換。
import fs from "node:fs";

const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);
const EOL = CR + NL;

function patchLines(path, pairs) {
  let s = fs.readFileSync(path, "utf8");
  for (const [badLines, goodLines] of pairs) {
    const bad = badLines.join(EOL);
    if (!s.includes(bad)) { console.error("ANCHOR NOT FOUND in " + path); process.exit(1); }
    s = s.replace(bad, goodLines.join(EOL));
  }
  fs.writeFileSync(path, s);
  console.log("patched: " + path);
}

patchLines("src/engine/browser-tools.js", [
  [
    "      const aRe = /<a\\s[^>]*?href=(?:\"([^\"]*)\"|'[^']*'|([^\\s>]+))[^>]*>([\\s\\S]*?)<\\/a\\s*>/gi;",
    "      const aRe = /<a\\s[^>]*?href=(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))[^>]*>([\\s\\S]*?)<\\/a\\s*>/gi;",
  ],
]);

patchLines("src/engine/browser-net.js", [
  [
    "      \"送信: \" + sub.method + \" \" + sub.url,",
    "      \"method: \" + sub.method + \" \" + sub.url,",
  ],
]);

console.log("done");
