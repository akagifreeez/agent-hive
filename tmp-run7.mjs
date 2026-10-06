import { spawnSync } from "node:child_process";
// runner配下で1テストだけ(node:testのfile並列も切る)--test-concurrency=1
const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "test/model-policy-conflict-wiring.test.js"], { encoding: "utf8", timeout: 280000 });
const out = (r.stdout ?? "") + (r.stderr ?? "");
const ls = out.split("\n").filter((l) => /✔|✖|pass |fail |Assertion|actual|expected|not ok|ok \d/.test(l));
process.stdout.write(ls.join("\n").slice(0, 2000) + "\n");
