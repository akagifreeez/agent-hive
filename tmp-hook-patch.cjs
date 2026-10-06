// hooks.test.js roundEndフックの\nリテラル破損修正(8進エスケープ)。edit_file不調回避のためnodeパッチ。
const fs = require("fs");
const p = "test/hooks.test.js";
let t = fs.readFileSync(p, "utf8");
const before = "fs.appendFileSync('rounds.txt', process.env.HIVE_HOOK_AGENT + '@' + process.env.HIVE_HOOK_THREAD + ':' + process.env.HIVE_HOOK_ENDED_BY + '\n')";
if (!t.includes(before)) { console.error("pattern not found"); process.exit(1); }
const after = "fs.appendFileSync('rounds.txt', process.env.HIVE_HOOK_AGENT + '@' + process.env.HIVE_HOOK_THREAD + ':' + process.env.HIVE_HOOK_ENDED_BY + '\010')";
t = t.replace(before, after);
fs.writeFileSync(p, t);
console.log("patched");
