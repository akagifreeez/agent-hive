import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, ["--test", "--test-name-pattern", "verify完了の競合経路", "test/model-policy-conflict-wiring.test.js"], { encoding: "utf8", timeout: 240000 });
const ls = (r.stdout ?? "").split("\n").filter((l) => /✔|✖|pass|fail|Assertion|Input|not ok|actual|expected/.test(l));
console.log(ls.join("\n").slice(0, 1200));
