// 単発テスト実行ラッパ(セマフォ経由だと600秒待ちが続くため、小さい1ファイルだけ内部spawnで実行)
import { spawnSync } from "node:child_process";
const target = process.argv[2] ?? "test/test-triage.test.js";
const r = spawnSync(process.execPath, ["--test", "--test-force-exit", target], { encoding: "utf8", timeout: 90000, env: { ...process.env, NODE_OPTIONS: "" } });
const tail = (s, n) => (s ?? "").split(String.fromCharCode(10)).slice(-n).join(String.fromCharCode(10));
console.log(tail(r.stdout, 40));
if (r.status !== 0) console.log("STDERR:", tail(r.stderr, 15));
console.log("exit=", r.status);
