import fs from "node:fs";
const p = "src/engine/loop.js";
let s = fs.readFileSync(p, "utf8");
const lines = s.split(/\r?\n/);
const idx = lines.findIndex((l) => l.includes('const text = fresh.map((p) => `${p.from}: ${p.text}`).join("\n---\n");'));
if (idx < 0) { console.error("anchor not found"); process.exit(1); }
lines[idx] = '      // メモリに残る参照は番号単独だと再起動後(/clearで再採番)に衝突するため、';
lines.splice(idx + 1, 0, '      // ラベル+日時付きで保存する(イシュー#20)。本文の先頭に#idを添える。');
lines.splice(idx + 2, 0, '      const text = fresh.map((p) => `${p.from} [#${p.id}${p.at ? " " + String(p.at).slice(0, 16).replace("T", " ") : ""}]: ${p.text}`).join("\n---\n");');
fs.writeFileSync(p, lines.join("\n"));
console.log("patched loop.js line", idx + 1);
