// 1テストだけタイムアウト計測つきで実行
import { spawnSync } from "node:child_process";
const t0 = Date.now();
const r = spawnSync(process.execPath, ["--test", "--test-name-pattern", "verify完了", "test/model-policy-conflict-wiring.test.js"], { encoding: "utf8", timeout: 150000 });
console.log("elapsed", Date.now() - t0);
console.log(r.stdout.split("\n").filter(l => /✔|✖|pass|fail|Assertion|not ok/.test(l)).join("\n").slice(0, 800));
