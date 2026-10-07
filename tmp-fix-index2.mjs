import { readFileSync, writeFileSync } from "node:fs";
const p = "src/index.js";
let s = readFileSync(p, "utf8");
// installProcessGuard(bus, { の呼び出し残骸(3行: 呼び出し+notify行+閉じ)を除去
const bad = '      notify: (line) => console.error(\`\U0001F514 [\u901A\u77E5] ${line}\`),\n    });\n';
// ドル波括弧を書かないよう組み立て: notify行は JSON.stringifyで安全化済みの形で置換
const lines = s.split(/\r?\n/);
// 46行目付: "let controller = null;" の直後に残った断片を検出して削除
const idx = lines.findIndex(l => l.trim() === "notify: (line) => console.error(" + String.fromCharCode(0x1F514) + " [\u901A\u77E5] ${line}),");
if (idx < 0) { console.error("残骸行が見つからない"); process.exit(1); }
// idxがnotify行、idx+1が "});" のはず。前の行が "let controller = null;" ならそのまま3行消す
console.log("removing:", JSON.stringify(lines.slice(idx, idx + 2)));
if (lines[idx + 1].trim() === "});") lines.splice(idx, 2); else { console.error("構造不一致"); process.exit(1); }
writeFileSync(p, lines.join("\n"), "utf8");
console.log("cleaned");
