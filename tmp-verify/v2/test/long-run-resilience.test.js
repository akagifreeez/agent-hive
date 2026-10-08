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


// (注) Node v24.20 の --test ランナー下ではテスト内で登録した process.on("uncaughtException")/
// unhandledRejection リスナに process.emit() が届かない(ランナー自身のハンドラが先に発火して)
// テストが落ちる)。実装のバグではなくランナー技術変化のため、これら3テストは子プロセス方式で固定する。
test("異常頻度: ガードはuncaughtExceptionも捕捉し、異常頻度警告・onEvent配信を子プロセスで固定", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-crash2b-"));
  try {
    const childPath = join(dir, "child.mjs");
    const guardUrl = pathToFileURL(join(process.cwd(), "src", "engine", "crash-guard.js")).href;
    writeFileSync(childPath, [
      "import { installCrashGuard } from \"" + guardUrl + "\";",
      "const events = [];",
      "let notified = [];",
      "const g = installCrashGuard({ logFile: process.argv[2], rateLimit: 3, rateWindowMs: 60000, onEvent: (e) => events.push(e), onNotify: (n) => notified.push(n) });",
      "// uncaughtException を子自身へ投げる(ガードが捕捉して生存する)",
      "setTimeout(() => { throw new Error(" + JSON.stringify("同期例外テスト") + "); }, 20);",
      "// しきい値(3)超えまで rejection を追加発射(既定窓60秒内)",
      "setTimeout(() => { Promise.reject(new TypeError(" + JSON.stringify("t0") + ")); }, 30);",
      "setTimeout(() => { Promise.reject(new TypeError(" + JSON.stringify("t1") + ")); }, 35);",
      "setTimeout(() => { Promise.reject(new TypeError(" + JSON.stringify("t2") + ")); }, 40);",
      "setTimeout(() => { Promise.reject(new TypeError(" + JSON.stringify("t3") + ")); }, 45);",
      "setTimeout(() => { Promise.reject(new TypeError(" + JSON.stringify("t4") + ")); }, 50);",
      "setTimeout(() => {",
      "  const rate = notified.filter((n) => n.kind === " + JSON.stringify("crash.rate") + ");",
      "  process.stdout.write(" + JSON.stringify("RESULT ") + " + JSON.stringify({ alive: true, count: g.guardCount(), kinds: events.map((e) => e.kind), rate: notified.filter((n) => n.kind === " + JSON.stringify("crash.rate") + "), warnings: g.warnings() }));",
      "}, 150);",
    ].join(String.fromCharCode(10)));
    const logPath = join(dir, "run-chat.err.log");
    const r = await new Promise((res) => {
      execFile(process.execPath, [childPath, logPath], { timeout: 15000, cwd: process.cwd() }, (err, stdout) => res({ err, stdout }));
    });
    assert.ok(!r.err, `子プロセスは生存(er=${r.err?.message?.slice(0, 80)})`);
    const m = r.stdout.match(/RESULT (.*)/);
    assert.ok(m, "結果ペイロードが出力される");
    const result = JSON.parse(m[1]);
    assert.ok(result.alive, "複数例外後も生存");
    assert.ok(result.count >= 6, `6件以上捕捉(actual=${result.count})`);
    assert.ok(result.kinds.includes("uncaughtException"), "uncaughtExceptionを捕捉");
    assert.ok(result.kinds.includes("unhandledRejection"), "unhandledRejectionを捕捉");
    assert.equal(result.rate.length, 1, "異常頻度警告は1回だけ");
    assert.match(result.rate[0].body, /異常頻度/);
    assert.equal(result.warnings, 1);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /uncaughtException/);
    assert.match(log, /同期例外テスト/, "必ずログへ残す");
    assert.match(log, /rate.warn/, "異常頻度もログへ残す");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onEvent配信とunwire(二重ガード防止)を子プロセスで固定", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-crash4b-"));
  try {
    const guardUrl = pathToFileURL(join(process.cwd(), "src", "engine", "crash-guard.js")).href;
    // 子A: unwire前に2種を捕捉しonEventへ順に流す(stacksでスタック全文も確認)
    const childPath = join(dir, "a.mjs");
    writeFileSync(childPath, [
      "import { installCrashGuard } from \"" + guardUrl + "\";",
      "const events = [];",
      "const g = installCrashGuard({ logFile: process.argv[2], onEvent: (e) => events.push(e) });",
      "setTimeout(() => { Promise.reject(new TypeError(" + JSON.stringify("terminated") + ")); }, 20);",
      "setTimeout(() => { throw new Error(" + JSON.stringify("boom") + "); }, 30);",
      "setTimeout(() => {",
      "  g.unwire();",
      "  process.stdout.write(" + JSON.stringify("RESULT ") + " + JSON.stringify({ kinds: events.map((e) => e.kind), stacks: events.map((e) => e.stack) }));",
      "}, 80);",
    ].join(String.fromCharCode(10)));
    const logPath = join(dir, "run-chat.err.log");
    const r = await new Promise((res) => {
      execFile(process.execPath, [childPath, logPath], { timeout: 15000, cwd: process.cwd() }, (err, stdout) => res({ err, stdout }));
    });
    assert.ok(!r.err, `子プロセスは生存(er=${r.err?.message?.slice(0, 80)})`);
    const m = r.stdout.match(/RESULT (.*)/);
    assert.ok(m, "結果ペイロードが出力される");
    const result = JSON.parse(m[1]);
    assert.deepEqual(result.kinds, ["unhandledRejection", "uncaughtException"], "onEventへ2種が順に流れる");
    assert.match(result.stacks[0], /terminated/, "スタック全文が流れる");
    // 対照: unwire後にrejectionを投げる子はガード無し同様に死ぬ(捕捉しない=二重ガード防止)
    const coverPath = join(dir, "b.mjs");
    writeFileSync(coverPath, [
      "import { installCrashGuard } from \"" + guardUrl + "\";",
      "const g = installCrashGuard({});",
      "setTimeout(() => { g.unwire(); }, 20);",
      "setTimeout(() => { Promise.reject(new TypeError(" + JSON.stringify("later") + ")); }, 60);",
    ].join(String.fromCharCode(10)));
    const cover = await new Promise((res) => {
      execFile(process.execPath, [coverPath], { timeout: 15000, cwd: process.cwd() }, (err) => res({ err }));
    });
    assert.ok(cover.err, "unwire後のrejectionは捕捉されずプロセスが死ぬ(対照)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
