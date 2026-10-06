import { readFileSync, writeFileSync } from "node:fs";
const p = "test/model-policy-conflict-wiring.test.js";
const ls = readFileSync(p, "utf8").split("\n");
// 残っていたHEAD側のconst r行(61行目)を削除(main側86行目を採用済み)
const idx = ls.findIndex((l) => l.includes('const r = await tools.execute("finish_task", { task_id: "verify-cw1" });'));
ls.splice(idx, 1);
writeFileSync(p, ls.join("\n"));
console.log("removed HEAD r at line", idx + 1);
