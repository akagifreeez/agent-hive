// プロセス死からの自動再起動ウォッチドッグ(long-run-resilience)の検証。
// 受け入れ基準:
//  (1) 「ダウン+marker有り」で起動処理を呼び、「稼働中/marker無し」で何もしない(テスト固定・疎通先差し替え可能)
//  (2) 再起動ログ(state/watchdog.log相当)が残る
//  (3) marker切替手段(on/off)が動く
// 外部に実アクセスしない(疎通先はローカルhttpサーバー、起動処理はspawnFn差し替えで固定)。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOnce, setWatchdog, watchdogEnabled } from "../src/engine/watchdog.js";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "watchdog-"));
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

/** 疎通用のローカルサーバー(死活=応答あり)。 */
function startUpServer() {
  return new Promise((resolve) => {
    const s = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, url: "http://127.0.0.1:" + s.address().port + "/api/state" }));
  });
}

function baseOpts(dir) {
  return {
    url: "http://127.0.0.1:1/no-such-port", // 既定では誰も listen していない番ポート=ダウン
    workspace: dir,
    markerPath: join(dir, "watchdog-on"),
    logPath: join(dir, "watchdog.log"),
    spawnFn: null, // 各テストで差し替え
  };
}

test("稼働中(疎通OK)なら何もしない(spawnFn不呼び)", async () => {
  const { server, url } = await startUpServer();
  try {
    const dir = mkdtempSync(join(tmpdir(), "wd-up-"));
    writeFileSync(join(dir, "watchdog-on"), "");
    let spawned = 0;
    const r = await checkOnce({ ...baseOpts(dir), url, spawnFn: () => { spawned++; return { pid: 1 }; } });
    assert.equal(r.action, "none");
    assert.equal(r.reason, "up");
    assert.equal(spawned, 0, "稼働中は起動しない");
    rmSync(dir, { recursive: true, force: true });
  } finally { server.close(); }
});

test("ダウン+marker無しなら何もしない(意図的停止を尊重)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-nomk-"));
  let spawned = 0;
  const r = await checkOnce({ ...baseOpts(dir), spawnFn: () => { spawned++; return { pid: 1 }; } });
  assert.equal(r.action, "none");
  assert.equal(r.reason, "no-marker");
  assert.equal(spawned, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("ダウン+marker有りで起動処理を呼び、再起動ログが残る", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-down-"));
  writeFileSync(join(dir, "watchdog-on"), "");
  const calls = [];
  const r = await checkOnce({
    ...baseOpts(dir),
    spawnFn: (cmd, args, opts2) => { calls.push({ cmd, args, opts2 }); return { pid: 4242 }; },
  });
  assert.equal(r.action, "respawn");
  assert.equal(calls.length, 1, "起動処理が1回呼ばれる");
  assert.match(calls[0].args.join(" "), /--chat/, "起動は --chat(常駐モード)");
  const log = readFileSync(join(dir, "watchdog.log"), "utf8");
  assert.match(log, /respawn/);
  assert.match(log, /4242/);
  rmSync(dir, { recursive: true, force: true });
});

test("marker切替: setWatchdog(true/false)でstate/watchdog-onが付く/消える", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-mk-"));
  const mk = join(dir, "state", "watchdog-on");
  assert.equal(watchdogEnabled(dir), false, "初期状態はOFF");
  setWatchdog(true, dir);
  assert.equal(existsSync(mk), true, "ONでmarker作成");
  assert.equal(watchdogEnabled(dir), true);
  setWatchdog(false, dir);
  assert.equal(existsSync(mk), false, "OFFでmarker削除");
  assert.equal(watchdogEnabled(dir), false);
  rmSync(dir, { recursive: true, force: true });
});

test("ウォッチドッグ実装が依存ゼロ(node:組み込みのみimport)", async () => {
  const src = readFileSync(join(here, "..", "src", "engine", "watchdog.js"), "utf8");
  const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(imports.length > 0, "importが存在する");
  for (const imp of imports) assert.match(imp, /^node:/, "外部依存は無し: " + imp);
});
