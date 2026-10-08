// 設定ウィンドウのAPIキー保存: /api/key で鍵ファイルへ書き出し+実行中configへ即時反映
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";
tokenedFetchOn();

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-key-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

test("設定API: /api/key で鍵ファイルを書き換え、configへ即時反映、stateにヒントが出る", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dataDir;
  try {
    // 鍵ファイルを既に持つ状態(dataDir側に作成)
    writeFileSync(join(dataDir, "test.key"), "sk-old-key-9999\n");
    const config = {
      workspace: ws, ui: { port: 0 }, model: { model: "m", apiKeyFile: "test.key", apiKeyEnv: "HIVE_TEST_KEY_X", apiKey: "sk-old-key-9999" },
      agents: [], budget: { maxTokensPerRun: 1 },
    };
    const ui = await startUiTokenized(startUi, { config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
    const base = `http://127.0.0.1:${config.ui.port}`;

    // stateに状態が出る(生の鍵ではなくヒント)
    const st = await (await fetch(base + "/api/state")).json();
    assert.equal(st.apiKey.set, true);
    assert.equal(st.apiKey.hint, "…9999");
    assert.ok(!JSON.stringify(st).includes("sk-old-key-9999"), "生の鍵はstateに載せない");

    // 保存: ファイル更新+config反映
    const r = await fetch(base + "/api/key", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "sk-new-key-abcd5678" }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.hint, "…5678");
    assert.equal(readFileSync(join(dataDir, "test.key"), "utf8").trim(), "sk-new-key-abcd5678", "既存の鍵ファイルを上書き");
    assert.equal(config.model.apiKey, "sk-new-key-abcd5678", "実行中configへ即時反映");

    // stateのヒントも更新
    const st2 = await (await fetch(base + "/api/state")).json();
    assert.equal(st2.apiKey.hint, "…5678");

    // バリデーション: 空・短すぎ
    assert.equal((await fetch(base + "/api/key", { method: "POST", headers: { "content-type": "application/json" }, body: '{"key":""}' })).status, 400);
    assert.equal((await fetch(base + "/api/key", { method: "POST", headers: { "content-type": "application/json" }, body: '{"key":"ab"}' })).status, 400);

    ui.close();
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA; else process.env.HIVE_DATA = prev;
    rmTree(ws); rmTree(dataDir);
  }
});

test("設定API: 鍵ファイル未作成の環境ではDATA側へ新規作成する", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dataDir;
  try {
    const config = {
      workspace: ws, ui: { port: 0 }, model: { model: "m", apiKeyFile: "test.key", apiKeyEnv: "HIVE_TEST_KEY_X" },
      agents: [], budget: { maxTokensPerRun: 1 },
    };
    const ui = await startUiTokenized(startUi, { config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
    const base = `http://127.0.0.1:${config.ui.port}`;
    const r = await fetch(base + "/api/key", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "sk-fresh-key-0000" }),
    });
    assert.equal(r.status, 200);
    assert.ok(existsSync(join(dataDir, "test.key")), "DATA側へ新規作成");
    assert.equal(readFileSync(join(dataDir, "test.key"), "utf8").trim(), "sk-fresh-key-0000");
    ui.close();
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA; else process.env.HIVE_DATA = prev;
    rmTree(ws); rmTree(dataDir);
  }
});
