import fs from "fs";
const p = "test/long-run-resilience.test.js";
let lines = fs.readFileSync(p, "utf8").split("\n");
// 84,85行の重複宣言を1行へ(0始まりindex 83,84)
if (lines[83] === lines[84]) { lines.splice(84, 1); fs.writeFileSync(p, lines.join("\n")); console.log("deduped"); }
else console.log("not dup:", JSON.stringify(lines[83]), JSON.stringify(lines[84]));
