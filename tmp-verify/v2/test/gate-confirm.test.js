// v6.13: confirm 段の検証 — curl/wget(外部送信の足がかり)と kill/taskkill(プロセス停止)は、
// auto モードであっても自動承認されず必ず承認要求を出す(denyではないため承認があれば実行可)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../src/engine/board.js";
import { PermissionGate } from "../src/engine/permissions.js";

function mkGate(mode = "auto") {
  const bus = new Bus();
  const gate = new PermissionGate({ bus, mode });
  return { bus, gate };
}

// 承認イベントを出して check の Promise を解決するヘルパ
function approveOn(bus, { approve = true, filter = () => true } = {}) {
  const off = bus.on("permission.request", (p) => {
    if (!filter(p)) return;
    queueMicrotask(() => {
      off();
      bus.emit("permission.verdict", { id: p.id, approve });
    });
  });
  return off;
}

test("confirm: autoモードでもcurlは自動承認されず、承認待ちになる(auto側で自動承認しない)", async () => {
  const { bus, gate } = mkGate("auto");
  const requests = [];
  bus.on("permission.request", (p) => requests.push(p));
  let resolved = null;
  // 誰も承認しない(短いタイムアウトで打ち切る)
  const shortGate = new PermissionGate({ bus: (bus), mode: "auto", confirm: ["curl", "wget", "kill ", "killall", "pkill", "taskkill", "Stop-Process", "Invoke-RestMethod"], askTimeoutSec: 0.2 });
  const t0 = Date.now();
  const r = await shortGate.check("curl -s -m 5 http://127.0.0.1:9");
  const elapsed = Date.now() - t0;
  assert.equal(r.allowed, false, "承認が無ければconfirm段は許可しない(autoでも)");
  assert.match(r.reason, /承認が.*秒以内/);
  assert.ok(elapsed >= 150, "自動承認(即時許可)ではなく待ちが発生している");
  assert.equal(requests.length, 1, "承認要求が1件出ている");
  assert.equal(requests[0].pattern, "curl");
  void resolved; void gate;
});

test("confirm: curl宛のlocalhostも送信の足がかりとして要承認(autoで即時許可されない)", async () => {
  const { bus } = mkGate("auto");
  const shortGate = new PermissionGate({ bus, mode: "auto", confirm: ["curl"], askTimeoutSec: 0.1 });
  const r = await shortGate.check("curl http://localhost:3000/api/state");
  assert.equal(r.allowed, false, "localhost宛でもconfirm段を素通りしない");
});

test("confirm: プロセス停止系(kill/taskkill)もautoで承認待ちになる", async () => {
  for (const cmd of ["kill -9 1234", "kill  1234", "killall node", "taskkill /F /PID 1234", "pkill -f hive"]) {
    const { bus } = mkGate("auto");
    const shortGate = new PermissionGate({ bus, mode: "auto", confirm: ["kill ", "killall", "pkill", "taskkill", "Stop-Process"], askTimeoutSec: 0.1 });
    const r = await shortGate.check(cmd);
    assert.equal(r.allowed, false, `autoで承認要求になるはず: ${cmd}`);
    assert.match(r.reason, /承認が/);
  }
});

test("confirm: 承認が得られれば実行可(denyではない)", async () => {
  const { bus, gate } = mkGate("auto");
  approveOn(bus);
  const r = await gate.check("curl -s -m 5 http://127.0.0.1:9");
  assert.deepEqual(r, { allowed: true }, "人の承認があれば許可");
});

test("confirm: 人が拒否すれば許可されない", async () => {
  const { bus, gate } = mkGate("auto");
  approveOn(bus, { approve: false });
  const r = await gate.check("kill -9 1234");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /人が拒否した/);
});

test("confirm: 通常コマンドはconfirm段を通らない(autoの即時許可を維持)", async () => {
  const { bus, gate } = mkGate("auto");
  const requests = [];
  bus.on("permission.request", (p) => requests.push(p));
  const r = await gate.check("ls -la && echo done");
  assert.deepEqual(r, { allowed: true });
  assert.equal(requests.length, 0, "承認要求は出ない");
});

test("confirm: 部分一致は誤爆しない(echo killing はkillとみなさない)", async () => {
  const { bus, gate } = mkGate("auto");
  const requests = [];
  bus.on("permission.request", (p) => requests.push(p));
  const r = await gate.check('echo killing time && echo "curl is a tool" > note.txt');
  assert.deepEqual(r, { allowed: true }, "先頭トークン一致のためechoはconfirm対象外");
  assert.equal(requests.length, 0);
});

test("confirm: 連結オプション(kill -9 → - 9 分割)でも「kill 」前方一致を捕捉", async () => {
  const { bus } = mkGate("auto");
  const shortGate = new PermissionGate({ bus, mode: "auto", confirm: ["kill ", "killall", "pkill", "taskkill", "Stop-Process"], askTimeoutSec: 0.1 });
  // normalizeConfirmArgv が -9 を - 9 へ分割するが、kill自体は先頭トークンなので捕捉される
  const r = await shortGate.check("kill -9 1234");
  assert.equal(r.allowed, false);
});

test("confirm: wget/Invoke-RestMethod も送信足がかりとして要承認", async () => {
  for (const cmd of ["wget http://example.invalid/x", "Invoke-RestMethod -Uri http://example.invalid"]) {
    const { bus } = mkGate("auto");
    const shortGate = new PermissionGate({ bus, mode: "auto", confirm: ["wget", "Invoke-RestMethod"], askTimeoutSec: 0.1 });
    const r = await shortGate.check(cmd);
    assert.equal(r.allowed, false, `要承認のはず: ${cmd}`);
  }
});

test("confirm: 既存askパターン(git push等)のauto自動承認挙動は従来どおり維持", async () => {
  const { bus, gate } = mkGate("auto");
  const requests = [];
  bus.on("permission.request", (p) => requests.push(p));
  const r = await gate.check("git push origin main");
  assert.deepEqual(r, { allowed: true }, "ask段はautoで自動承認(confirmと差別化)");
  assert.equal(requests.length, 0, "待ちなしの自動承認");
});

test("confirm: normalモードでも同様に承認要求→拒否/承認が機能する", async () => {
  const { bus, gate } = mkGate("normal");
  approveOn(bus, { approve: false });
  const denied = await gate.check("curl http://example.invalid");
  assert.equal(denied.allowed, false);
  const { bus: bus2, gate: gate2 } = mkGate("normal");
  approveOn(bus2, { approve: true });
  const allowed = await gate2.check("curl http://example.invalid");
  assert.deepEqual(allowed, { allowed: true });
});
