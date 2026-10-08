// long-run-resilience: ネットワーク瞬断でのプロセス死を防ぐ回帰固定。
// (1) ストリーム途中切断(undici TypeError: terminated相当)でアダプタがリトライして
//     最終的に行動化可能な結果またはエラーを返す(プロセスは落ちない=例外が飛ばない)。
// (2) 子プロセスでunhandledRejection/uncaughtExceptionを投げても、ガード付き起動では
//     生存し、run-chat.err.logへスタック全文が残る。
// (3) ガードは必ずログへ残す(Error以外のrejectionも文字列化して記録)。
// (4) 異常頻度(1時間20件超)で「異常頻度」警告を1回だけ出す。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenAIModel, setModelSleep, RETRY_MAX_RETRIES } from "../src/model/openai.js";
import { installCrashGuard, guardRateLimit } from "../src/engine/crash-guard.js";

function sseThenAbortResponse(chunksBeforeAbort, abortErr, eofAfterChunks = false) {
  const encoder = new TextEncoder();
  let sent = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent < chunksBeforeAbort.length) return { done: false, value: encoder.encode(chunksBeforeAbort[sent++]) };
          if (eofAfterChunks) return { done: true, value: undefined }; // 正常EOF(チャンク消化後に例外を投げない)
          throw abortErr; // 読み出し中に接続が切れる(EOFではなく例外)
        },
      }),
    },
  };
}

test("ストリーム途中切断(TypeError: terminated)はリトライされて成功する(プロセスは落ちない)", async () => {
  const origFetch = globalThis.fetch;
  const origSleep = setModelSleep((ms) => ms); // 待ち時間ゼロ(テスト高速化)
  const delays = [];
  setModelSleep((ms) => { delays.push(ms); return Promise.resolve(); });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    // 1回目: SSEを少し流した直後にundiciの瞬断(コード無しTypeError: terminated)
    if (calls === 1) return sseThenAbortResponse(['data: {"choices":[{"delta":{"content":"par"}}]}\n\n'], Object.assign(new TypeError("terminated"), { code: undefined }));
    // 2回目: 正常完了(abortErr=nullでもチャンク消化後のthrowが起きないようdoneで終端)
    return sseThenAbortResponse([
      'data: {"choices":[{"delta":{"content":"tial"}}]}\n\n',
      "data: [DONE]\n\n",
    ], null, /* eofAfterChunks */ true);
  };
  try {
    const m = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m", timeoutMs: 1000 });
    const r = await m.chat({ messages: [{ role: "user", content: "hi" }], onDelta: () => {} });
    assert.equal(calls, 2, "terminated後にリトライしている");
    assert.equal(r.content, "tial");
    assert.ok(delays.length >= 1, "リトライ待ちが挟まる");
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep(origSleep);
  }
});

test("リトライ使い切りの瞬断は行動化可能なエラーとして返る(rejectionにならない)", async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return sseThenAbortResponse([], new TypeError("terminated")); };
  const origSleep = setModelSleep(() => Promise.resolve());
  try {
    const m = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m", timeoutMs: 1000 });
    await assert.rejects(
      () => m.chat({ messages: [{ role: "user", content: "hi" }], onDelta: () => {} }),
      /ストリームが切断されました/,
    );
    assert.equal(calls, RETRY_MAX_RETRIES + 1, "初回+最大リトライで打ち切り");
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep(origSleep);
  }
});

// ===== 子プロセスでガードの生存を固定する =====
// 子はtmpdir配下で動くため相対importでは解決できない(fileURLで絶対参照にする)
const guardUrl = pathToFileURL(join(process.cwd(), "src", "engine", "crash-guard.js")).href;
const CHILD_SRC = [
  "import { installCrashGuard } from \"" + guardUrl + "\";",
  "const g = installCrashGuard({ logFile: process.argv[2] });",
  "// uncaughtRejection(undici terminatedを模したError)",
  "Promise.reject(Object.assign(new TypeError(\"terminated\"), { code: undefined }));",
  "// 非Error値のrejection(ガードは必ず文字列化してログへ残す)",
  "setTimeout(() => { Promise.reject(\"文字列rejection\"); }, 20);",
  "setTimeout(() => {",
  "  try { process.stdout.write(\"ALIVE \" + g.guardCount() + String.fromCharCode(10)); } catch {}",
  "}, 80);",
].join(String.fromCharCode(10));
const CHILD_COVER = `
// 対照: ガード無し。process.onを置かないのでrejectionで死ぬ(exit 1)
Promise.reject(new TypeError("terminated"));
setTimeout(() => { process.stdout.write("ALIVE\\n"); }, 80);
`;

test("子プロセス: ガード付きはunhandledRejection後に生存しログへ残る", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-crash-"));
  try {
    const childPath = join(dir, "child.mjs");
    const coverPath = join(dir, "cover.mjs");
    writeFileSync(childPath, CHILD_SRC);
    writeFileSync(coverPath, CHILD_COVER);
    // 対照実験: ガード無しはプロセスが死ぬ(exit code 1)
    const noGuard = await new Promise((res) => {
      execFile(process.execPath, [coverPath], { timeout: 15000, cwd: process.cwd() }, (err, stdout) => res({ err, stdout }));
    });
    assert.ok(noGuard.err, "ガード無しの対照はrejectionで死ぬ(exit 1)");
    // ガード付き: 生存してALIVEを出す
    const logPath = join(dir, "run-chat.err.log");
    const withGuard = await new Promise((res) => {
      execFile(process.execPath, [childPath, logPath], { timeout: 15000, cwd: process.cwd() }, (err, stdout) => res({ err, stdout }));
    });
    assert.ok(!withGuard.err, `ガード付きは生存(erc=${withGuard.err?.code})`);
    assert.match(withGuard.stdout, /ALIVE 2/, "2件のrejectionを捕捉して生存");
    // ログへスタック全文+文字列rejectionも記録(必ずログ)
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /unhandledRejection/);
    assert.match(log, /terminated/);
    assert.match(log, /文字列rejection/, "Error以外のrejectionも文字列化して記録");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ガードはuncaughtExceptionも捕捉し、必ずログへ残す", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-crash2-"));
  try {
    const childPath = join(dir, "child.mjs");
    writeFileSync(childPath, [
      `import { installCrashGuard } from "../src/engine/crash-guard.js";`,
      `const g = installCrashGuard({ logFile: process.argv[2] });`,
      `setTimeout(() => { throw new Error("同期例外テスト"); }, 20);`,
      `setTimeout(() => { process.stdout.write("ALIVE " + g.guardCount() + "\\n"); }, 80);`,
    ].join("\n"));
    const logPath = join(dir, "run-chat.err.log");
    const r = await new Promise((res) => {
      execFile(process.execPath, [childPath, logPath], { timeout: 15000, cwd: process.cwd() }, (err, stdout) => res({ err, stdout }));
    });
    assert.ok(!r.err, `生存(er=${r.err?.message?.slice(0, 80)})`);
    assert.match(r.stdout, /ALIVE 1/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /uncaughtException/);
    assert.match(log, /同期例外テスト/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("異常頻度: 1時間の窓でしきい値超過したら「異常頻度」警告を1回だけ出す", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-crash3-"));
  try {
    const logPath = join(dir, "run-chat.err.log");
    let notified = [];
    const g = installCrashGuard({ logFile: logPath, rateLimit: 3, rateWindowMs: 60_000, onNotify: (n) => notified.push(n) });
    assert.equal(guardRateLimit(), 20, "既定しきい値は20");
    console.error("Lcount=" + process.listenerCount("unhandledRejection")); for (let i = 0; i < 3; i++) process.emit("unhandledRejection", new TypeError(`t${i}`));
    assert.equal(notified.filter((n) => n.kind === "crash.rate").length, 0, "しきい値以下は警告しない");
    process.emit("unhandledRejection", new TypeError("t3"));
    process.emit("unhandledRejection", new TypeError("t4"));
    const burst = notified.filter((n) => n.kind === "crash.rate");
    assert.equal(burst.length, 1, "しきい値超過で1回だけ警告");
    assert.match(burst[0].body, /異常頻度/);
    assert.equal(g.warnings(), 1);
    // 窓が空けば再度検出できる(リセット確認はフラグ経由)
    g.unwire();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onEvent/onPostフック経由でbusに流れ、board投稿に使える", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-crash4-"));
  try {
    const logPath = join(dir, "run-chat.err.log");
    const events = [];
    const g = installCrashGuard({ logFile: logPath, onEvent: (e) => events.push(e) });
    process.emit("unhandledRejection", new TypeError("terminated"));
    process.emit("uncaughtException", new Error("boom"));
    assert.deepEqual(events.map((e) => e.kind), ["unhandledRejection", "uncaughtException"]);
    assert.match(events[0].stack, /terminated/);
    g.unwire();
    // unwire後は捕捉しない(二重ガード防止の検証)
    const events2 = [];
    const g2 = installCrashGuard({ logFile: logPath, onEvent: (e) => events2.push(e) });
    g2.unwire();
    process.emit("unhandledRejection", new TypeError("later"));
    assert.equal(events2.length, 0, "unwire後は捕捉しない");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
