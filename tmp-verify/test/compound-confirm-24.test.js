// イシュー#24: 複合コマンドのconfirm判定 — 2番目以降の実行単位にconfirm必須コマンド
// (curl/wget/kill等)が含まれても、autoモードで承認要求なしに許可されないこと。
// 判定のみを検証し、実際にコマンドは実行しない(既存方針踏襲)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../src/engine/board.js";
import { PermissionGate, splitExecUnits } from "../src/engine/permissions.js";

function mkGate(mode = "auto", askTimeoutSec = 0.1) {
  const bus = new Bus();
  const gate = new PermissionGate({ bus, mode, askTimeoutSec });
  const requests = [];
  bus.on("permission.request", (p) => requests.push(p));
  return { bus, gate, requests };
}

// 承認イベントを自動で返すヘルパ
function approveOn(bus, approve = true) {
  const off = bus.on("permission.request", (p) => {
    queueMicrotask(() => {
      off();
      bus.emit("permission.verdict", { id: p.id, approve });
    });
  });
}

test("splitExecUnits: 複合コマンドを実行単位へ分割する", () => {
  assert.deepEqual(
    splitExecUnits("echo ready; curl -s http://x && kill -9 1 || ls | wc"),
    ["echo ready", "curl -s http://x", "kill -9 1", "ls", "wc"]
  );
  // 単一コマンドは1単位のまま
  assert.deepEqual(splitExecUnits("ls -la"), ["ls -la"]);
  // 空や区切りのみは捨てる
  assert.deepEqual(splitExecUnits(";; && ||"), []);
  assert.deepEqual(splitExecUnits(""), []);
});

test("イシュー#24: 複合コマンド2番目のcurlはautoでも承認要求(allowed=false)", async () => {
  const { bus, gate, requests } = mkGate("auto");
  const r = await gate.check("echo ready; curl -s http://127.0.0.1:9");
  assert.equal(r.allowed, false, "2番目以降の実行単位でも素通りさせない");
  assert.ok(requests.length >= 1, "承認要求が出ている");
  assert.match(r.reason, /承認が/);
});

test("イシュー#24: 2番目のkill -9 / 3番目のwgetもautoで承認要求", async () => {
  for (const cmd of ["echo ready && kill -9 1234", "echo a; echo b; wget http://example.invalid/x"]) {
    const { gate, requests } = mkGate("auto");
    const r = await gate.check(cmd);
    assert.equal(r.allowed, false, `承認要求になるはず: ${cmd}`);
    assert.ok(requests.length >= 1, `承認要求1件以上: ${cmd}`);
  }
});

test("イシュー#24: 承認が得られれば複合コマンドも許可(denyではない)", async () => {
  const { bus, gate } = mkGate("auto");
  approveOn(bus, true);
  const r = await gate.check("echo ready; curl -s http://127.0.0.1:9");
  assert.deepEqual(r, { allowed: true }, "人の承認があれば許可");
});

test("イシュー#24: 人が拒否すれば複合コマンドは許可されない", async () => {
  const { bus, gate } = mkGate("auto");
  approveOn(bus, false);
  const r = await gate.check("echo ready; curl -s http://127.0.0.1:9");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /人が拒否した/);
});

test("イシュー#24: 通常の複合コマンドはconfirm段を通らない(誤爆なし)", async () => {
  const { gate, requests } = mkGate("auto");
  const r = await gate.check("ls -la && echo done");
  assert.deepEqual(r, { allowed: true });
  assert.equal(requests.length, 0, "承認要求は出ない");
});

test("イシュー#24: 部分一致の誤爆は複合でも起きない(echo killing; echo hi)", async () => {
  const { gate, requests } = mkGate("auto");
  const r = await gate.check("echo killing time; echo hi");
  assert.deepEqual(r, { allowed: true }, "先頭トークン一致のためechoはconfirm対象外");
  assert.equal(requests.length, 0);
});

test("イシュー#24: 承認要求にはコマンド全体が載る(単位ではない)", async () => {
  const { bus, gate, requests } = mkGate("auto", 5);
  const p = gate.check("echo ready; curl -s http://127.0.0.1:9");
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].command, "echo ready; curl -s http://127.0.0.1:9", "全体が監査対象");
  assert.equal(requests[0].pattern, "curl", "hitしたconfirmパターン(旧契約どおり)");
  bus.emit("permission.verdict", { id: requests[0].id, approve: false });
  const r = await p;
  assert.equal(r.allowed, false);
});
