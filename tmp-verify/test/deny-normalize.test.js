// deny/askパターン照合のコマンド正規化検証: 空白圧縮とオプション結合(`rm -r -f`→`rm -rf`)の
// 自明な回避形を捕捉できること
import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionGate, normalizeCommand } from "../src/engine/permissions.js";

test("normalizeCommand: 空白圧縮とオプション結合を吸収する", () => {
  assert.equal(normalizeCommand("rm   -rf    /"), "rm -rf /");
  assert.equal(normalizeCommand("rm -r -f /"), "rm -rf /");
  assert.equal(normalizeCommand("rm  -r  -f   /"), "rm -rf /");
  // 非オプション引数は結合しない
  assert.equal(normalizeCommand("git reset --hard HEAD~1"), "git reset --hard HEAD~1");
  assert.equal(normalizeCommand("echo a   b"), "echo a b");
});

test("deny: 空白圧縮・オプション結合の回避形でも即拒否される", async () => {
  const gate = new PermissionGate({ mode: "auto" });
  for (const cmd of [
    "rm  -rf   /",
    "rm -r -f /",
    "rm  -r -f  /",
    "shutdown  -h  now",
    "mkfs  -t  ext4  /dev/sda1",
  ]) {
    const r = await gate.check(cmd);
    assert.equal(r.allowed, false, `should deny: ${cmd}`);
  }
});

test("normalizeCommand: オプション順序入替も正規形へ寄せる(sort)", () => {
  assert.equal(normalizeCommand("rm -f -r /", { sort: true }), "rm -fr /");
  assert.equal(normalizeCommand("rm -fr /", { sort: true }), "rm -fr /");
  // ソートなしでは従来どおり(結合のみ、順序は保持)
  assert.equal(normalizeCommand("rm -f -r /"), "rm -fr /");
});

test("deny: オプション順序入替の回避形でも即拒否される", async () => {
  const gate = new PermissionGate({ mode: "auto" });
  for (const cmd of ["rm -f -r /", "rm  -f  -r  /", "rm -fr ~"]) {
    const r = await gate.check(cmd);
    assert.equal(r.allowed, false, `should deny: ${cmd}`);
  }
});

test("ask: オプション順序入替された破壊的コマンドも承認対象になる", async () => {
  const gate = new PermissionGate({ mode: "auto" });
  for (const cmd of ["rm -f -r ./build", "git clean -df"]) {
    const r = await gate.check(cmd);
    assert.equal(r.allowed, true, `auto mode should approve(=ask hit): ${cmd}`);
  }
});

test("ask: オプション結合された破壊的コマンドも承認対象になる", async () => {
  const gate = new PermissionGate({ mode: "auto" });
  for (const cmd of ["git  reset --hard", "git reset --hard", "git clean  -fd", "rm -r -f ./build"]) {
    const r = await gate.check(cmd);
    assert.equal(r.allowed, true, `auto mode should approve(=ask hit): ${cmd}`);
  }
  // 通常コマンドは承認不要
  const ok = await gate.check("ls  -la");
  assert.equal(ok.allowed, true);
});
