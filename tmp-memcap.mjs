import fs from "node:fs";
const p = "src/engine/chat.js";
let s = fs.readFileSync(p, "utf8");
const NL = s.includes("\r\n") ? "\r\n" : "\n";
const lines = s.split(NL);
// 1) コンストラクタへ memMaxMessages を追加(既定200)
const anchorC = lines.findIndex((l) => l.includes("autoContinueRounds = 3, // ターン上限でも仕事が残っていれば自動で次ラウンドへ(0=従来どおり停止)"));
if (anchorC < 0) { console.error("anchorC not found"); process.exit(1); }
lines.splice(anchorC + 1, 0, "    memMaxMessages = 200, // 会話メモリ(mem-*.json)の上限メッセージ数。超えたらsystem+冒頭を残して古い分を刈り取り(イシュー#20)");
const anchorA = lines.findIndex((l) => l.includes("this.autoContinueRounds = autoContinueRounds;"));
if (anchorA < 0) { console.error("anchorA not found"); process.exit(1); }
lines.splice(anchorA + 1, 0, "    this.memMaxMessages = Number(memMaxMessages) > 10 ? Number(memMaxMessages) : 200;");
// 2) saveMemoriesに刈り取りを追加(system+冒頭1件+直近を保持。要約はコスト不要のため刈り取り方式)
const anchorS = lines.findIndex((l) => l.includes("// 一時ファイル経由の原子書込(クラッシュ時の半端JSONで復元が壊れるのを防ぐ)"));
if (anchorS < 0) { console.error("anchorS not found"); process.exit(1); }
const capLines = [
  "      // 上限刈り取り(イシュー#20): messagesがmemMaxMessagesを超えたら、system+冒頭の seeds",
  "      // 2件と直近(上限-余白)だけを残し、間の古い分を捨てる。刈り取った件数はイベントで告知。",
  "      const all = this.memories.get(main.id) ?? [];",
  "      let messages = all;",
  "      if (this.memMaxMessages > 0 && all.length > this.memMaxMessages) {",
  "        const keepHead = all[0]?.role === \"system\" ? 1 : 0;",
  "        const head = all.slice(0, keepHead + 1); // system+冒頭1(seed)",
  "        const tailCount = this.memMaxMessages - head.length - 1;",
  "        const tail = all.slice(all.length - Math.max(tailCount, 1));",
  "        messages = [...head, { role: \"user\", content: `[メモリ整理] 古い会話 \" + (all.length - messages2Len(head, tail)) + \"件を刈り取りました(上限 \" + this.memMaxMessages + \")。経過はボード(memory/gather_context)から読めます。` }, ...tail];",
  "        this.bus?.emit(\"memory.pruned\", { agent: main.id, before: all.length, after: messages.length });",
  "      }",
];
// 上の行は複雑なのでシンプルに書き直す: messages2Lenなど使わない
capLines[10] = "        const pruned = all.length - messages.length;";
capLines[11] = "        messages = [...head, { role: \"user\", content: \"[メモリ整理] 古い会話 \" + pruned + \" 件を刈り取りました(上限 \" + this.memMaxMessages + \")。経過はボード(memory/gather_context)から読めます。\" }, ...tail];";
lines.splice(anchorS, 0, ...capLines);
// 3) 書き込み対象を messages へ
const anchorW = lines.findIndex((l) => l.includes("writeFileSync(tmp, JSON.stringify({ messages: this.memories.get(main.id) }));"));
if (anchorW < 0) { console.error("anchorW not found"); process.exit(1); }
lines[anchorW] = "      writeFileSync(tmp, JSON.stringify({ messages }));";
fs.writeFileSync(p, lines.join(NL));
console.log("patched chat.js");
