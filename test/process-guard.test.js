// プロセス生存ガード(long-run-resilience)の検証。
// 受け入れ基準: (1)子プロセスでunhandledRejectionを投げてもガード後に生存しログへ出る(テスト固定)
// (2)ガードは必ずログに残す (3)同種連発で「異常頻度」警告。
// 注意: node:testランナー自体が自プロセス内の未捕捉rejectionを失敗扱いにするため、
// rejection/例外の発生はすべて子プロセスに分離する(ここが本物の挙動に近い検証になる)。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Bus } from "../src/engine/board.js";
import { wireProcessErrorToBoards } from "../src/engine/process-error-wiring.js";

const here = dirname(fileURLToPath(import.meta.url));
const guardModuleUrl = pathToFileURL(join(here, "..", "src", "engine", "process-guard.js")).href;
const tmp = mkdtempSync(join(tmpdir(), "pguard-"));
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

/** 子プロセスを立ててexitコード/標準出力/標準エラーを回収する */
function runChild(code) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", errAll = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { errAll += d; });
    c.on("error", reject);
    c.on("close", (exitCode) => resolve({ exitCode, out, errAll }));
  });
}

test("子プロセス: unhandledRejectionを投げてもガード後に生存し、ログへスタック全文", async () => {
  const logFile = join(tmp, "rejection.log").split("\\").join("/");
  const r = await runChild(`
    const { installProcessGuard } = await import(${JSON.stringify(guardModuleUrl)});
    installProcessGuard(null, { logFile: ${JSON.stringify(logFile)} });
    Promise.reject(new Error("子プロセスrejectionテスト用の未捕捉拒否"));
    setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 200);
  `);
  assert.equal(r.exitCode, 0, `ガード後に生存して自発exit(0)。stderr: ${r.errAll.slice(0, 200)}`);
  assert.match(r.out, /SURVIVED/);
  const logged = readFileSync(logFile, "utf8");
  assert.match(logged, /unhandledRejection/, "ログへ種別が残る");
  assert.match(logged, /子プロセスrejectionテスト用の未捕捉拒否/, "ログへメッセージが残る");
  assert.match(logged, /\n\s+at /, "スタック全文(at行)が残る");
});

test("子プロセス: uncaughtExceptionでも生存し、ログへ残る", async () => {
  const logFile = join(tmp, "exception.log").split("\\").join("/");
  const r = await runChild(`
    const { installProcessGuard } = await import(${JSON.stringify(guardModuleUrl)});
    installProcessGuard(null, { logFile: ${JSON.stringify(logFile)} });
    setTimeout(() => { throw new Error("子プロセス同期例外テスト"); }, 10);
    setTimeout(() => { console.log("SURVIVED2"); process.exit(0); }, 250);
  `);
  assert.equal(r.exitCode, 0, `例外後も生存。stderr: ${r.errAll.slice(0, 200)}`);
  assert.match(r.out, /SURVIVED2/);
  const logged = readFileSync(logFile, "utf8");
  assert.match(logged, /uncaughtException/);
  assert.match(logged, /子プロセス同期例外テスト/);
});

test("子プロセス: 同種連発で1時間窓の「異常頻度」警告(bus.process.burst)。1回だけ", async () => {
  const r = await runChild(`
    const { installProcessGuard } = await import(${JSON.stringify(guardModuleUrl)});
    const { Bus } = await import(${JSON.stringify(pathToFileURL(join(here, "..", "src", "engine", "board.js")).href)});
    const bus = new Bus();
    const bursts = [];
    bus.on("process.burst", (p) => bursts.push(p));
    installProcessGuard(bus, { logFile: null, threshold: 2, windowMs: 60000 });
    for (let i = 0; i < 4; i++) Promise.reject(new Error("連発" + i));
    setTimeout(() => { console.log("BURSTS=" + JSON.stringify(bursts)); process.exit(0); }, 250);
  `);
  assert.equal(r.exitCode, 0, `生存を確認。stderr: ${r.errAll.slice(0, 200)}`);
  const m = r.out.match(/BURSTS=(\[[\s\S]*\])/);
  assert.ok(m, "bus警告の集計が出力される");
  const bursts = JSON.parse(m[1]);
  assert.equal(bursts.length, 1, "警告は窓内1回だけ(連投防止)");
  assert.ok(bursts[0].count > 2, "件数がしきい値超を報告する");
  assert.equal(bursts[0].threshold, 2);
});

test("wireProcessErrorToBoards: process.errorを各boardへ[システム]投稿する", () => {
  const bus = new Bus();
  const posted = [];
  const board = { name: "th", post: (from, text) => posted.push({ from, text }) };
  const wiring = wireProcessErrorToBoards(bus, { boards: [board] });
  bus.emit("process.error", { kind: "unhandledRejection", message: "配線テスト", stack: "Error: 配線テスト", at: new Date().toISOString() });
  bus.emit("process.burst", { count: 25, threshold: 20, windowMs: 3600000, at: new Date().toISOString() });
  assert.equal(posted.length, 2);
  assert.deepEqual(posted.map((p) => p.from), ["system", "system"]);
  assert.match(posted[0].text, /プロセス警告/);
  assert.match(posted[0].text, /配線テスト/);
  assert.match(posted[0].text, /run-chat\.err\.log/);
  assert.match(posted[1].text, /異常頻度/);
  wiring.unwire();
  bus.emit("process.error", { kind: "unhandledRejection", message: "unwire後は流れない", stack: "", at: new Date().toISOString() });
  assert.equal(posted.length, 2, "unwire後は投稿されない");
});
