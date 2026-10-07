import { readFileSync, writeFileSync } from "node:fs";
const NL = String.fromCharCode(10);
const p = "hive.config.json";
const lines = readFileSync(p, "utf8").split(NL);
const i = lines.findIndex((l) => l.includes('"intervalSec": 120'));
if (i < 0) throw new Error("anchor missing");
const block = [
  '    "intervalSec": 120,',
  '    "probes": {',
  '      "triage": {',
  '        "mode": "off",',
  '        "command": "npm test",',
  '        "timeoutMs": 300000,',
  '        "knownFailures": [',
  '          { "file": "test/long-run-resilience.test.js", "name": "ストリーム途中切断(TypeError: terminated)はリトライされて成功する(プロセスは落ちない)", "area": "stream-stall", "note": "TDD途中領域: 非同期後始末の競合。10-04時点の既知失敗" },',
  '          { "file": "test/long-run-resilience.test.js", "name": "子プロセス: ガード付きはunhandledRejection後に生存しログへ残る", "area": "crash-guard", "note": "TDD途中領域: 子プロセス生存検証" },',
  '          { "file": "test/long-run-resilience.test.js", "name": "ガードはuncaughtExceptionも捕捉し、必ずログへ残す", "area": "crash-guard", "note": "TDD途中領域: 子プロセス生存検証" },',
  '          { "file": "test/long-run-resilience.test.js", "name": "異常頻度: 1時間の窓でしきい値超過したら「異常頻度」警告を1回だけ出す", "area": "crash-guard", "note": "TDD途中領域" },',
  '          { "file": "test/long-run-resilience.test.js", "name": "onEvent/onPostフック経由でbusに流れ、board投稿に使える", "area": "hooks", "note": "TDD途中領域: hooks経路" },',
  '          { "file": "test/retry.test.js", "name": "chat(stream): stall検知でリトライし、2回目で成功する", "area": "stream-stall", "note": "TDD途中領域: stall検知のタイミング依存" },',
  '          { "file": "test/model-policy.test.js", "name": "承認フロー競合経路: 差し戻し記録がtools.jsから呼ばれてもReferenceErrorしない(modelPolicy未指定=既定動作)", "area": "approval-conflict", "note": "一時gitリポジトリ初期化の競合" },',
  '          { "file": "test/cli.test.js", "name": "CLI: cancel/release/reopen/auditが実サーバーに対して動く", "area": "cli", "note": "実サーバー系の負荷依存" }',
  '        ]',
  '      }',
  '    }',
];
lines.splice(i, 1, ...block);
writeFileSync(p, lines.join(NL));
console.log("config patched");
