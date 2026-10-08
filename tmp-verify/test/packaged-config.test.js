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

test("HIVE_UI_PORT: ui.portを環境変数で上書きできる(梱包SMOKEの衝突避け)", async () => {
  const prevData = process.env.HIVE_DATA;
  const prevPort = process.env.HIVE_UI_PORT;
  process.env.HIVE_DATA = resolve(mkdtempSync(join(tmpdir(), "hive-port-")));
  process.env.HIVE_UI_PORT = "7802";
  try {
    const { loadConfig } = await import("../src/config.js");
    assert.equal(loadConfig().ui.port, 7802);
    delete process.env.HIVE_UI_PORT;
    assert.equal(loadConfig().ui.port, 7789, "無指定時は既定値に戻る");
    process.env.HIVE_MONITOR_PORT = "7793";
    assert.equal(loadConfig().ui.monitorPort, 7793, "モニタポートも上書きできる");
    delete process.env.HIVE_MONITOR_PORT;
  } finally {
    if (prevData === undefined) delete process.env.HIVE_DATA; else process.env.HIVE_DATA = prevData;
    if (prevPort === undefined) delete process.env.HIVE_UI_PORT; else process.env.HIVE_UI_PORT = prevPort;
  }
});

test("hive.local.jsonのmcp.serversでMCP設定を追加/上書きできる", async () => {
  const userData = resolve(mkdtempSync(join(tmpdir(), "hive-mcplocal-")));
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = userData;
  try {
    const { writeFileSync } = await import("node:fs");
    const { loadConfig } = await import("../src/config.js");
    writeFileSync(join(userData, "hive.local.json"), JSON.stringify({
      mcp: { servers: { echo: { command: "node", args: ["echo.mjs"] } } },
    }));
    const cfg = loadConfig();
    assert.equal(cfg.mcp.servers.echo.command, "node");
    // 同名はローカル側が上書き
    writeFileSync(join(userData, "hive.local.json"), JSON.stringify({
      mcp: { servers: { echo: { command: "node", args: ["v2.mjs"] } } },
    }));
    assert.deepEqual(loadConfig().mcp.servers.echo.args, ["v2.mjs"]);
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    try { rmSync(userData, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
  }
});
