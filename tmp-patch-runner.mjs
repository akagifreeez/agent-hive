import { readFileSync, writeFileSync } from "node:fs";
const p = "src/runner.js";
const src = readFileSync(p, "utf8");
if (src.includes("t.host.unsubscribe")) { console.log("already patched"); process.exit(0); }
const nl = src.includes("\r\n") ? "\r\n" : "\n";
const anchor = ["    threads.delete(name);", "    writeRegistry();", '    bus.emit("thread.closed", { name });'].join(nl);
if (!src.includes(anchor)) { console.error("anchor not found"); process.exit(1); }
const insertion = ["    threads.delete(name);", "    writeRegistry();", '    if (typeof t.host?.unsubscribe === "function") t.host.unsubscribe(); // 閉じたスレッドのHostはイベントで再起床しない(イシュー#29)', '    bus.emit("thread.closed", { name });'].join(nl);
writeFileSync(p, src.replace(anchor, insertion));
console.log("runner.js patched (eol=" + JSON.stringify(nl) + ")");
