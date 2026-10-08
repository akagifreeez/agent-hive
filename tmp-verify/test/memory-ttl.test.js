// メモリTTL(claude-flow手本): ttl宣言つきの記憶は寿命切れで注入から外れる(ファイルは残す)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryContext, isMemoryExpired } from "../src/engine/memory.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-ttl-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

test("ttlつき記憶: 新鮮な間は注入され、寿命切れで外れる。ファイル自体は消さない", () => {
  const ws = mktmp();
  const dir = join(ws, "memory");
  mkdirSync(dir, { recursive: true });

  const tempFile = join(dir, "temp-note.md");
  writeFileSync(tempFile, "ttl: 1h\nこのあたりは一時的な合意\n");
  const permFile = join(dir, "00-pc-operation-rules.md");
  writeFileSync(permFile, "# 永久のルール\n常に守ること\n");

  // 新鮮なうちは注入される(ttl行そのものは注入しない)
  assert.equal(isMemoryExpired(ws, "temp-note.md"), false);
  let ctx = buildMemoryContext(ws);
  assert.match(ctx, /一時的な合意/);
  assert.doesNotMatch(ctx, /ttl:/);
  assert.match(ctx, /永久のルール/);

  // mtimeを過去へ(2時間前)→ 寿命切れ。注入から外れるがファイルは残る
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(tempFile, past, past);
  assert.equal(isMemoryExpired(ws, "temp-note.md"), true);
  ctx = buildMemoryContext(ws);
  assert.doesNotMatch(ctx, /一時的な合意/);
  assert.match(ctx, /永久のルール/, "ttl無しの記憶は寿命に関係なく注入される");
  assert.ok(existsSync(tempFile), "寿命切れでもファイルは消さない");

  rmTree(ws);
});

test("ttl表記: 30m/7d/0mを解釈する。宣言が無ければ永久", () => {
  const ws = mktmp();
  const dir = join(ws, "memory");
  mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000); // 10分前

  writeFileSync(join(dir, "a.md"), "ttl: 30m\n30分のみ有効\n"); // 10分前では未然
  assert.equal(isMemoryExpired(ws, "a.md"), false);
  utimesSync(join(dir, "a.md"), old, old);
  // 10分前 + 30分 = まだ生きている
  assert.equal(isMemoryExpired(ws, "a.md"), false);

  writeFileSync(join(dir, "b.md"), "ttl: 7d\n7日間有効\n");
  utimesSync(join(dir, "b.md"), old, old);
  assert.equal(isMemoryExpired(ws, "b.md"), false);

  writeFileSync(join(dir, "c.md"), "ttl: 0m\n即時失効の検証用\n");
  utimesSync(join(dir, "c.md"), old, old); // mtime粒度の誤差を避けるため明示的に過去へ
  assert.equal(isMemoryExpired(ws, "c.md"), true, "0mは即時失効");

  writeFileSync(join(dir, "d.md"), "# 宣言なしの記憶\n本文\n");
  utimesSync(join(dir, "d.md"), old, old);
  assert.equal(isMemoryExpired(ws, "d.md"), false, "宣言が無い限り永久");

  rmTree(ws);
});
