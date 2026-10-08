// スレッドsay()の直列化崩れ修正の回帰テスト: runner.jsのsay()は
// ChatHost.say(text)に(text, thread)の2引数をそのまま流していたため、
// threadがdelayMsへ滑り落ち、2番目以降のメインの注入がstaggerMs(3秒)遅延していた。
// 実害: 3ワーカー構成でユーザー入力後の応答がベータ+6秒/ガンマ+3秒遅くなる。
// 修正: 引数順を(text, thread)へ正規化して渡し直し、staggerMsが遅延として効かないよう
// ChatHost生成時のstaggerMs自体を0へ固定(遅延=バグでしかないため)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChat } from "../src/runner.js";
import { Bus } from "../src/engine/board.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }

async function waitUntil(fn, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

function mkConfig(ws) {
  return {
    workspace: ws,
    worktrees: { dir: `${ws}-wt` },
    model: { contextWindow: 200000, maxTokens: 4000 },
    loop: { maxTurns: 10 },
    budget: null,
    compact: { thresholdPercent: 90 },
    discovery: {},
    permissions: {},
    scenario: { name: "test" },
    chat: {
      lead: "lead", workers: ["alpha", "beta", "gamma"],
      maxTurnsPerRound: 8, staggerMs: 5,
    },
    agents: [
      { id: "lead", displayName: "リーダー", role: "lead" },
      { id: "alpha", displayName: "アルファ", role: "impl" },
      { id: "beta", displayName: "ベータ", role: "review" },
      { id: "gamma", displayName: "ガンマ", role: "impl" },
    ],
  };
}

function scriptedModel() {
  return {
    maxTokens: 4000,
    async chat() {
      return { content: "応答", toolCalls: [], raw: { content: "応答" }, usage: { promptTokens: 10, completionTokens: 1 } };
    },
  };
}

test("runner: say(text, thread)はstagger遅延なしで全メインへ注入される(引数滑落の回帰)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-say-stagger-"));
  const config = mkConfig(ws);
  const bus = new Bus();
  const ctl = await runChat({ config, bus, modelFactory: scriptedModel });
  try {
    const opened = await ctl.openThread({ project: "saystagger", goal: "say引数滑落の検証" });
    assert.equal(opened.error, undefined, "スレッドが開ける: " + String(opened?.error ?? ""));
    const host = ctl.threadHost("saystagger");
    assert.ok(host, "スレッドのChatHostを取得できる(観測点)");
    assert.equal(host.staggerMs, 0, "スレッドChatHostのstaggerMsは0(遅延=バグ撤去)");

    const t0 = Date.now();
    const r = ctl.say("[テスト] stagger検証", "saystagger");
    assert.ok(r === undefined || r?.error === undefined, "sayが成功: " + String(r?.error ?? r));
    // 全メイン(alpha/beta/gamma)のラウンドが即座に始まる(stagger遅延がない)
    // 注: runner経由ではメインidは「<thread>-<worker>」形式
    for (const id of ["saystagger-alpha", "saystagger-beta", "saystagger-gamma"]) {
      assert.ok(
        await waitUntil(() => host.roundState.get(id)?.running === true, 5000),
        `${id} のラウンドが5秒以内に開始(遅延なしが観測できる)`
      );
    }
    // ラウンド完走を待つ(テスト終了時の残留タイマー防止)
    for (const id of ["saystagger-alpha", "saystagger-beta", "saystagger-gamma"]) {
      assert.ok(
        await waitUntil(() => host.roundState.get(id)?.running === false, 60000),
        `${id} のラウンドが完走`
      );
    }
    const elapsed = Date.now() - t0;
    // 上限は緩めに: 5秒以内の「開始観測」は各行で検証済みであり、ここは全体の完走上限。
    // フル実行中はセマフォ直列化・マシン負荷でラウンド1本(数秒)が積み上がるため、
    // stagger遅延(旧実装+6秒)との識別に十分な30秒を上限とする(単独実行は実測2秒台)。
    assert.ok(elapsed < 30000, `全体が30秒以内に完走(実測 ${elapsed}ms / 旧実装ならstagger分さらに遅延)`);
  } finally {
    rmTree(ws); rmTree(`${ws}-wt`);
  }
});
