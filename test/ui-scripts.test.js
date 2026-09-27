// /api/scripts: package.jsonのnpm scripts検出API
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi, detectNpmScripts } from "../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-scripts-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

test("detectNpmScripts: package.jsonのscriptsを名前順で検出する", () => {
  const ws = mktmp();
  try {
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test", dev: "vite" } }));
    const scripts = detectNpmScripts(ws);
    assert.deepEqual(scripts.map((s) => s.name).sort(), ["dev", "test"]);
    assert.equal(scripts.find((s) => s.name === "dev").cmd, "vite");
  } finally { rmTree(ws); }
});

test("detectNpmScripts: scripts無し/読めない場合は空配列", () => {
  const ws = mktmp();
  try {
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "x" }));
    assert.deepEqual(detectNpmScripts(ws), []);
    // package.json自体が無い
    const ws2 = mktmp();
    try { assert.deepEqual(detectNpmScripts(ws2), []); } finally { rmTree(ws2); }
  } finally { rmTree(ws); }
});

test("UI API: /api/scriptsが検出結果を返す", async () => {
  const ws = mktmp();
  try {
    writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { start: "node ." } }));
    const config = { workspace: ws, ui: { port: 0 }, model: { model: "base" }, agents: [], budget: { maxTokensPerRun: 1 } };
    const ui = await startUi({ config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
    try {
      const r = await (await fetch(`http://127.0.0.1:${config.ui.port}/api/scripts`)).json();
      assert.deepEqual(r.scripts, [{ name: "start", cmd: "node ." }]);
    } finally { ui.close(); }
  } finally { rmTree(ws); }
});
