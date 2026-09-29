// fix-browser-tools-impl 追加パッチ3(単純化): 文字列置換のみ。CRLFは\r文字を含む素通し置換。
import fs from "node:fs";

const CR = String.fromCharCode(13);

function rep(path, bad, good) {
  let s = fs.readFileSync(path, "utf8");
  if (!s.includes(bad)) { console.error("ANCHOR NOT FOUND in " + path + ": " + JSON.stringify(bad.slice(0, 80))); process.exit(1); }
  s = s.replace(bad, good);
  fs.writeFileSync(path, s);
  console.log("patched: " + path);
}

// 1) browser-tools.js: hrefの第2グループ化('単引用の内容を捕捉')
rep(
  "src/engine/browser-tools.js",
  "href=(?:\"([^\"]*)\"|'[^']*'|([^\\s>]+))",
  "href=(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))"
);

// 2) browser-net.js: レポート1行目の書式(送信: → method: )
rep(
  "src/engine/browser-net.js",
  "\"" + CR + NL + "      \"送信: \" + sub.method" ,
  "\"" + CR + NL + "      \"method: \" + sub.method"
);
rep(
  "src/engine/browser-net.js",
  "\"送信: \" + sub.method + \" \" + sub.url,",
  "\"method: \" + sub.method + \" \" + sub.url,"
);

console.log("done");
