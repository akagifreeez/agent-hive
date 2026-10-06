// イシュー#24対応: confirm必須コマンドの判定がコマンド全体の先頭トークンしか見ず、
// 複合コマンド「echo ready; curl …」「echo ok && kill -9 …」の2番目以降の実行単位で
// 承認要求なしに allowed=true になっていた問題の回帰テスト。
// 判定のみで実際にコマンドは実行しない(既存 gate-confirm.test.js の方針踏襲)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../src/engine/board.js";
import { PermissionGate, splitShellSegments } from "../src/engine/permissions.js";

function mkGate(mode = "auto", opts = {}) {
  const bus = new Bus();
  const gate = new PermissionGate({ bus, mode, askTimeoutSec: 0.1, ...opts });
  return { bus, gate };
}

// 承認イベントを受けると即座にverdictを返すヘルパ(approve=false既定)
function denyOnRequest(bus, { approve = false } = {}) {
  const off = bus.on("permission.request", (p) => {
    queueMicrotask(() => {
      off();
      bus.emit("permission.verdict", { id: p.id, approve });
    });
  });
  return off;
}

test("#24: 複合コマンド2番目(curl)はautoでも承認要求となりallowed=false", async () => {
  const { bus, gate } = mkGate("auto");
  const requests = [];
  bus.on("permission.request", (p) => requests.push(p));
  const r = await gate.check("echo ready; curl http://example.invalid");
  assert.equal(r.allowed, false, "2番目のcurlは素通りしない");
  assert.ok(requests.length >= 1, "approvalRequests>=1");
  assert.equal(requests[0].pattern, "curl");
});

test("#24: 複合コマンド2番目(kill)もautoで承認要求となる", async () => {
  const { bus } = mkGate("auto");
  const shortGate = new PermissionGate({ bus, mode: "auto", confirm: ["curl", "wget", "kill ", "killall", "pkill", "taskkill", "Stop-Process"], askTimeoutSec: 0.1 });
  const r = await shortGate.check("echo ok && kill -9 1234");
  assert.equal(r.allowed, false, "2番目のkill -9は素通りしない");
});

test("#24: 承認が得られれば複合コマンドは実行可(denyではない)", async () => {
  const { bus, gate } = mkGate("auto");
  denyOnRequest(bus, { approve: true });
  const r = await gate.check("echo ready; curl http://example.invalid");
  assert.deepEqual(r, { allowed: true }, "人の承認があれば許可");
});

test("#24: 3番目以降の実行単位も捕捉する", async () => {
  const { bus, gate } = mkGate("auto");
  const r = await gate.check("echo a && echo b; pkill -f hive");
  assert.equal(r.allowed, false, "3番目のpkillも素通りしない");
});

test("#24: パイプと改行区切りの実行単位も判定する", async () => {
  const { bus, gate } = mkGate("auto");
  const requests = [];
  bus.on("permission.request", (p) => requests.push(p));
  const r1 = await gate.check("echo hello | curl -s http://example.invalid");
  assert.equal(r1.allowed, false, "パイプ後のcurlは素通りしない");
  const r2 = await gate.check("echo a\ncurl http://example.invalid");
  assert.equal(r2.allowed, false, "改行後のcurlは素通りしない");
});

test("#24: クォート内の区切り文字は分割しない(誤爆防止)", async () => {
  const { bus, gate } = mkGate("auto");
  const requests = [];
  bus.on("permission.request", (p) => requests.push(p));
  const r = await gate.check('echo "a; curl b" && ls');
  assert.deepEqual(r, { allowed: true }, "文字列内のcurlはコマンドではない");
  assert.equal(requests.length, 0);
});

test("#24: 部分一致の誤爆は既存どおり防止(echo killing / 文字列内curl)", async () => {
  const { bus, gate } = mkGate("auto");
  const requests = [];
  bus.on("permission.request", (p) => requests.push(p));
  const r = await gate.check('echo killing time && echo "curl is a tool" > note.txt');
  assert.deepEqual(r, { allowed: true }, "先頭トークン一致のためechoはconfirm対象外");
  assert.equal(requests.length, 0);
});

test("#24: 先頭がconfirm対象の単一コマンドは従来どおり要承認", async () => {
  const { bus, gate } = mkGate("auto");
  const r = await gate.check("curl http://example.invalid");
  assert.equal(r.allowed, false, "curl単体はautoでも承認待ち");
});

test("#24: 通常コマンドの複合はconfirm段を通らない(auto即時許可を維持)", async () => {
  const { bus, gate } = mkGate("auto");
  const requests = [];
  bus.on("permission.request", (p) => requests.push(p));
  const r = await gate.check("ls -la && echo done; pwd | wc -l");
  assert.deepEqual(r, { allowed: true });
  assert.equal(requests.length, 0);
});

test("#24: splitShellSegmentsの分割単位(クォート保護と区切り網羅)", () => {
  assert.deepEqual(splitShellSegments('echo ready; curl http://x'), ["echo ready", "curl http://x"]);
  assert.deepEqual(splitShellSegments('echo "a; curl b" && ls'), ['echo "a; curl b"', "ls"]);
  assert.deepEqual(splitShellSegments("a || b"), ["a", "b"]);
  assert.deepEqual(splitShellSegments("echo x | y"), ["echo x", "y"]);
  assert.deepEqual(splitShellSegments("a &&\n b; c"), ["a", "b", "c"]);
  assert.deepEqual(splitShellSegments(""), []);
});
