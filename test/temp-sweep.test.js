import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, utimesSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sweepHiveTempWorkspaces } from "../src/engine/temp-sweep.js";

// sweepに渡すrootはこの下に隔離する。実%TEMP%のhive-*は絶対に触らない
function isolatedRoot() {
  const base = mkdtempSync(join(tmpdir(), "hive-sweep-self-"));
  const root = join(base, "scan");
  mkdirSync(root, { recursive: true });
  return { base, root };
}

function ageDir(dir, hoursAgo) {
  const t = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  utimesSync(dir, t, t);
}

test("temp-sweep: 古いhive-*だけを消し、新しいhive-*と無関係なdirは残す", () => {
  const { base, root } = isolatedRoot();
  const oldDir = join(root, "hive-old-abc");
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, "out.txt"), "x");
  mkdirSync(join(oldDir, "state"), { recursive: true });
  mkdirSync(join(root, "hive-new-def"), { recursive: true });
  mkdirSync(join(root, "other-ghi"), { recursive: true });
  ageDir(oldDir, 48);

  const r = sweepHiveTempWorkspaces({ root, now: Date.now() });
  assert.deepEqual(r, { removed: 1, failed: 0, kept: 1 });
  assert.equal(existsSync(oldDir), false);
  assert.equal(existsSync(join(root, "hive-new-def")), true);
  assert.equal(existsSync(join(root, "other-ghi")), true);
  rmForce(base);
});

test("temp-sweep: dryRunは何も消さず対象数だけ返す", () => {
  const { base, root } = isolatedRoot();
  const dir = join(root, "hive-dry-mno");
  mkdirSync(dir, { recursive: true });
  ageDir(dir, 48);

  const r = sweepHiveTempWorkspaces({ root, dryRun: true, now: Date.now() });
  assert.deepEqual(r, { removed: 1, failed: 0, kept: 0 });
  assert.equal(existsSync(dir), true, "dryRunでは消えない");
  rmForce(base);
});

test("temp-sweep: 読み取り専用ファイル(gitオブジェクト相当)があっても消せる", () => {
  const { base, root } = isolatedRoot();
  const dir = join(root, "hive-ro-jkl");
  mkdirSync(join(dir, ".git", "objects"), { recursive: true });
  const f = join(dir, ".git", "objects", "p1");
  writeFileSync(f, "x");
  chmodSync(f, 0o444);
  ageDir(dir, 48);

  const r = sweepHiveTempWorkspaces({ root, now: Date.now() });
  assert.equal(r.removed, 1);
  assert.equal(r.failed, 0);
  assert.equal(existsSync(dir), false);
  rmForce(base);
});

test("temp-sweep: rootが存在しない場合はゼロを返して落ちない", () => {
  const r = sweepHiveTempWorkspaces({ root: join(tmpdir(), "hive-sweep-no-such-root-xyz"), now: Date.now() });
  assert.deepEqual(r, { removed: 0, failed: 0, kept: 0 });
});

function rmForce(p) {
  // テスト自身の後始末。mkdtempSyncの親(tmpdir直下)にhive-sweep-self-*を残さない
  rmSync(p, { recursive: true, force: true });
}
