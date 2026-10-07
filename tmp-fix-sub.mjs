import { readFileSync, writeFileSync } from "node:fs";
const p = "src/engine/chat.js";
const src = readFileSync(p, "utf8");
const nl = src.includes("\r\n") ? "\r\n" : "\n";
let fixed = 0;
const lines = src.split(nl);
for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const bare = raw.replace(/\r$/, "");
  const m = bare.match(/^(\s*)this\._subscriptions\.push\(("(?:[^"]+)"), \((\w+)\) => (this\.[A-Za-z]+\(.*\))\);$/);
  if (m) {
    const cr = raw.endsWith("\r") ? "\r" : "";
    // bus.on( ... ) を push へ: push(bus.on("ev", (p) => fn));
    lines[i] = m[1] + "this._subscriptions.push(bus.on(" + m[2] + ", (" + m[3] + ") => " + m[4] + "));" + cr;
    fixed++;
  }
}
if (fixed !== 6) { console.error("expected 6, got " + fixed); process.exit(1); }
writeFileSync(p, lines.join(nl));
console.log("fixed", fixed, "subscription lines");
