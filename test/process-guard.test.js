// プロセス生存ガード(long-run-resilience)の検証。
// 受け入れ基準: (1)子プロセスでunhandledRejectionを投げてもガード後に生存しログへ出る
// (2)ガードは必ずログに残す(コンソール+ファイル) (3)同種連発で「異常頻度」警告
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Bus } from "../src/engine/board.js";
import { installProcessGuard, GUARD_BURST_THRESHOLD } from "../src/engine/process-guard.js";
import { wireProcessErrorToBoards } from "../src/engine/process-error-wiring.js";

const tmp = mkdtempSync(join(tmpdir(), "pguard-"));
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

test("installProcessGuard: unhandledRejectionを捕捉して生存+ファイルログへスタック全文", async () => {
  const logFile = join(tmp, "err1.log");
  const bus = new Bus();
  const events = [];
  bus.on("process.error", (p) => events.push(p));
  const guard = installProcessGuard(bus, { logFile });
  // Promise.reject(未捕捉rejection)を投げて、次のティックで捕捉されるのを待つ
  Promise.reject(new Error("子プロセスrejectionテスト用の未捕捉拒否"));
  await new Promise((r) => setTimeout(r, 60));
  guard.unwire();
  assert.equal(events.length, 1, "busへprocess.errorイベントが1件流れる");
  assert.equal(events[0].kind, "unhandledRejection");
  assert.match(events[0].message, /未捕捉拒否/);
  const logged = readFileSync(logFile, "utf8");
  assert.match(logged, /unhandledRejection/, "ログに種別が残る");
  assert.match(logged, /未捕捉拒否/, "ログにメッセージが残る");
  assert.match(logged, /at /, "スタック全文(位置情報)が残る");
});

test("installProcessGuard: uncaughtExceptionでも生存しログへ残る", async () => {
  const logFile = join(tmp, "err2.log");
  const guard = installProcessGuard(null, { logFile });
  setTimeout(() => { throw new Error("同期例外のテスト"); }, 1);
  await new Promise((r) => setTimeout(r, 80));
  guard.unwire();
  const logged = readFileSync(logFile, "utf8");
  assert.match(logged, /uncaughtException/);
  assert.match(logged, /同期例外のテスト/);
});

test("異常頻度: 1時間窓でしきい値超えたらprocess.burst警告(1回だけ)", async () => {
  const bus = new Bus();
  const bursts = [];
  bus.on("process.burst", (p) => bursts.push(p));
  const guard = installProcessGuard(bus, { logFile: null, threshold: 3, windowMs: 60_000 });
  for (let i = 0; i < 4; i++) { Promise.reject(new Error(`連発${i}`)); }
  await new Promise((r) => setTimeout(r, 80));
  guard.unwire();
  assert.equal(bursts.length, 1, "警告は1回だけ(連投防止)");
  assert.ok(bursts[0].count > 3, "件数がしきい値超を報告する");
});

test("wireProcessErrorToBoards: process.errorを各boardへ[システム]投稿する", async () => {
  const bus = new Bus();
  const posted = [];
  const board = { name: "th", post: (from, text) => posted.push({ from, text }) };
  const wiring = wireProcessErrorToBoards(bus, { boards: [board] });
  bus.emit("process.error", { kind: "unhandledRejection", message: "配線テスト", stack: "Error: 配線テスト", at: new Date().toISOString() });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].from, "system");
  assert.match(posted[0].text, /プロセス警告/);
  assert.match(posted[0].text, /配線テスト/);
  assert.match(posted[0].text, /run-chat\.err\.log/);
  wiring.unwire();
});

test("子プロセスE2E: ガード配線済みのスクリプトがrejection後に生存して終了コード0+ログ残存", async () => {
  const logFile = join(tmp, "child.log");
  const script = join(tmp, "child.mjs");
  // ワークスペースのprocess-guardを直接importする子プロセス(相対パスを絶対化)
  const guardPath = new URL("../src/engine/process-guard.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  writeFileSync(script, `
    import { installProcessGuard } from ${JSON.stringify(guardPath.split("\\\\").join("/"))};
    installProcessGuard(null, { logFile: ${JSON.stringify(logFile)} });
    Promise.reject(new Error("子プロセスE2E用rejection"));
    setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 150);
  `);
  const code = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", errAll = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { errAll += d; });
    c.on("error", reject);
    c.on("close", (code) => resolve({ code, out, errAll }).code);
  });
  assert.equal(code, 0, `ガード後に子プロセスは生存して自発的にexit(0)する(標準エラー: ログ出力を含む)`);
  const logged = readFileSync(logFile, "utf8");
  assert.match(logged, /子プロセスE2E用rejection/);
});
