// 梱包実行時のパス解決: HIVE_DATA(userData)を付けると書き込み系がそちらへ寄ること
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("HIVE_DATA: workspace/worktrees/ローカル上書きがuserData基準になる", async () => {
  const userData = resolve(mkdtempSync(join(tmpdir(), "hive-data-")));
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = userData;
  try {
    // envを設定してから呼び出す(dataDir()は呼び出し時にenvを解決する)
    const { loadConfig, dataDir } = await import("../src/config.js");
    assert.equal(dataDir(), userData);

    const cfg = loadConfig();
    assert.ok(cfg.workspace.startsWith(userData), "workspaceはuserData配下");
    assert.ok(cfg.worktrees.dir.startsWith(userData), "worktreesもuserData配下");
    // persona(agents/*.md)は同梱物なのでROOT基準のまま(HIVE_DATAに寄せない)

    // ローカル上書き(hive.local.json)もDATA側から読む
    writeFileSync(join(userData, "hive.local.json"), JSON.stringify({ workspace: join(userData, "myws") }));
    const cfg2 = loadConfig();
    assert.equal(cfg2.workspace, resolve(join(userData, "myws")));
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    try { rmSync(userData, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
  }
});
