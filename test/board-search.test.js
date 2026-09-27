// ボード全文検索: /api/board?q= の検証。
// 全スレッド横断で本文部分一致、新しい順、limit既定50、thread絞り込み、UI同梱チェック。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";

tokenedFetchOn();

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-boardsearch-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

// startUiを立て、スレッドを開き、各Boardへ投稿させてから検索APIを叩くヘルパー。
// スレッドのJSONLは openThread 経由(実運用と同じ board-<thread>.jsonl)で作る。
async function setup() {
  const ws = mktmp();
  const bus = new Bus();
  const config = {
    workspace: ws,
    ui: { port: 0 },
    model: { model: "test" },
    agents: [],
    budget: { maxTokensPerRun: 1 },
  };
  const opened = [];
  const ui = await startUiTokenized(startUi, {
    config, modelFactory: () => ({}), bus, autoStart: false,
    onThread: (req) => {
      const name = req.project;
      const b = new Board(bus, name, join(ws, "state", `board-${name}.jsonl`));
      opened.push(b);
      bus.emit("thread.opened", { name, goal: req.goal, agents: [] });
      return { ok: true, id: name };
    },
  });
  const base = `http://127.0.0.1:${config.ui.port}`;
  const get = async (path) => {
    const r = await fetch(base + path);
    return { status: r.status, body: await r.json() };
  };
  const post = async (path, body) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const postThread = (name, goal) => post("/api/thread", { project: name, goal });
  return { ws, bus, config, ui, base, get, post, postThread, boards: () => opened };
}

test("/api/board?q= が全スレッド横断で本文部分一致を新しい順に返す(複数スレッドのヒット)", async () => {
  const { ws, ui, postThread, boards, get } = await setup();
  try {
    await postThread("search-alert-r7", "検索と通知");
    await postThread("other-thread", "別の取り組み");
    // リードの投稿はRAM(live.board)経由なのでディスク永続化されないが、検索はlive.boardも走査する
    // (リポジトリ運用ではBoardStoreのJSONLが真実。テストではRAMのみの投稿も拾えることを確認する)
    for (let i = 1; i <= 60; i++) boards()[0].post("lead", `スレッドAの投稿${i}`);
    boards()[0].post("impl-9", "ニッチなキーワードはここにあります");
    // スレッドBを確実に「後から」にする(同msだとat順がスレッド間で不定になるため)
    await new Promise((r) => setTimeout(r, 3));
    for (let i = 1; i <= 30; i++) boards()[1].post("worker", `スレッドBの投稿${i}`);
    boards()[1].post("impl-9", "ニッチなキーワードは別スレッドにもあります");
    boards()[1].post("impl-9", "ニッチなキーワード3つ目");

    const r = await get("/api/board?q=%E3%83%8B%E3%83%83%E3%83%81");
    assert.equal(r.status, 200);
    assert.equal(r.body.query, "ニッチ");
    assert.equal(r.body.total, 3, "複数スレッド横断で3件ヒット");
    assert.equal(r.body.posts.length, 3);
    // 新しい順(at降順、同時刻はid降順)。スレッドBが厳密に新しいためBが先頭、
    // B内の同着2件はid降順で3つ目→別スレッドにも
    assert.deepEqual(r.body.posts.map((p) => p.text), [
      "ニッチなキーワード3つ目",
      "ニッチなキーワードは別スレッドにもあります",
      "ニッチなキーワードはここにあります",
    ]);
    for (const p of r.body.posts) {
      for (const k of ["id", "from", "text", "at", "thread"]) assert.ok(k in p, `key ${k}`);
    }
    assert.ok(r.body.posts.every((p) => p.thread && p.thread !== ""), "各ヒットにスレッド名が載る");
  } finally {
    ui.close();
    rmTree(ws);
  }
});

test("/api/board?q= はlimit既定50・limit指定で件数制限・大文字小文字を無視して一致", async () => {
  const { ws, ui, postThread, boards, get } = await setup();
  try {
    await postThread("t-limit", "limit検証");
    const b = boards()[0];
    for (let i = 1; i <= 70; i++) b.post("lead", `件数稼ぎ${i}`);
    for (let i = 1; i <= 70; i++) b.post("alpha", `キーワード命中${i}`);

    // 既定limit=50
    const r1 = await get("/api/board?q=%E5%91%BD%E4%B8%AD");
    assert.equal(r1.status, 200);
    assert.equal(r1.body.posts.length, 50, "既定limitは50");
    assert.equal(r1.body.total, 70, "totalはヒット全件");
    // 新しい順(降順)の先頭が最新
    assert.ok(r1.body.posts[0].text.includes("70"));

    const r2 = await get("/api/board?q=%E5%91%BD%E4%B8%AD&limit=5");
    assert.equal(r2.body.posts.length, 5, "limit指定で絞られる");
    assert.equal(r2.body.total, 70, "totalは絞り込み前のヒット数");
    assert.ok(r2.body.posts[0].text.includes("70"), "絞り込みも新しい順の先頭");
  } finally {
    ui.close();
    rmTree(ws);
  }
});

test("/api/board?q=&thread= で1スレッドに絞って検索する", async () => {
  const { ws, ui, postThread, boards, get } = await setup();
  try {
    await postThread("t-one", "絞り込み");
    await postThread("t-two", "ノイズ側");
    boards()[0].post("alpha", "一意信号はこちら");
    boards()[0].post("beta", "一意信号2件目");
    boards()[1].post("gamma", "一意信号はノイズ側にもある");

    const r = await get(`/api/board?q=${encodeURIComponent("一意信号")}&thread=${encodeURIComponent("t-one")}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.thread, "t-one");
    assert.equal(r.body.total, 2, "スレッド絞り込みでノイズ側を除外");
    assert.ok(r.body.posts.every((p) => p.thread === "t-one"));
  } finally {
    ui.close();
    rmTree(ws);
  }
});

test("/api/board?q= は大文字小文字を無視して部分一致する", async () => {
  const { ws, ui, postThread, boards, get } = await setup();
  try {
    await postThread("t-case", "case");
    boards()[0].post("alpha", "The QuickSort algorithm rocks");
    const r = await get(`/api/board?q=${encodeURIComponent("quicksort")}`);
    assert.equal(r.body.total, 1);
    assert.match(r.body.posts[0].text, /QuickSort/);
  } finally {
    ui.close();
    rmTree(ws);
  }
});

test("q未指定は従来どおり頁送りとして振る舞い、空qはエラー", async () => {
  const { ws, ui, get, postThread, boards } = await setup();
  try {
    await postThread("t-legacy", "互換");
    boards()[0].post("lead", "レガシー投稿");
    const noQ = await get("/api/board");
    assert.equal(noQ.status, 200);
    assert.ok(Array.isArray(noQ.body.posts), "q無しは従来どおりpostsを返す");
    assert.ok(!("query" in noQ.body), "q無しの応答に検索用フィールドは無い");

    const emptyQ = await get("/api/board?q=");
    assert.equal(emptyQ.status, 400);
    assert.ok(emptyQ.body.error);
  } finally {
    ui.close();
    rmTree(ws);
  }
});

test("UI(index.html)にボード検索ボックスと結果一覧があり、スレッド切替の導線を持つ", async () => {
  const html = readFileSync(join(repoRoot, "src/ui/public/index.html"), "utf8");
  // 検索UI: 入力欄(id=board-search)と結果コンテナ(id=board-search-results)
  assert.match(html, /id="board-search"/);
  assert.match(html, /id="board-search-results"/);
  // API呼び出し: /api/board?q= をUIから叩く
  assert.match(html, /\/api\/board\?q=/);
  // 結果クリックでスレッド切替: selectedThread を更新する導線
  assert.match(html, /openBoardSearchResult|boardSearchOpenThread|selectedThread\s*=/);
});
