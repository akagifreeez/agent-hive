import { readFileSync, writeFileSync } from "node:fs";
const p = "src/engine/chat.js";
const lines = readFileSync(p, "utf8").split("\n");
const norm = (s) => s.replace(/\r$/, "");
// 実測(1始まり): 85=push(task.released) / 86=空 / 87,88=コメント / 89=unsubscribe(){ / 96='  }'(ub終端) / 97='  }'(ctor終端) / 98=空 / 99=コメント(新タスク投入時)
// → 97行目(ctor終端)を85行の直後(=index84の後)へ移動
const i85 = lines.findIndex((l) => norm(l).includes('push("task.released"'));
const i97 = lines.findIndex((l) => norm(l) === "  }" && lines.indexOf(l) >= i85 + 11);
// 安全に: i85を0始まりindexへ(見つかった行が85行目)
if (i85 < 0) { console.error("anchor 85 not found"); process.exit(1); }
const idx97 = i85 + 12; // 0始まり: 85行目=index84 → 97行目=index96
if (norm(lines[idx97]) !== "  }") { console.error("idx97 NG:", JSON.stringify(norm(lines[idx97]))); process.exit(1); }
lines.splice(idx97, 1);        // ctor終端'  }'を取り除く
lines.splice(i85 + 1, 0, "  }"); // 85行目の後へ挿入 → 順序: push85 / '}'86 / 空87 / コメント88,89 / unsubscribe90...97 / 空 / コメント
writeFileSync(p, lines.join("\n"));
console.log("ctor end moved. order:");
lines.slice(i85 - 1, i85 + 12).forEach((l, k) => console.log(i85 + k, JSON.stringify(norm(l).slice(0, 60))));
