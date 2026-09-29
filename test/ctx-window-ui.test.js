// コンテキストウィンドウ消費量の表示(GitHubイシュー#17):
// - loop.jsが usage-trace 記録時に bus へ usage.trace を発行する
// - server.jsが usage.trace を受けて live.agents[id].ctx へ 使用/上限/残り を計算して保持し
//   /api/state で配布する(エージェント詳細パネルのデータ源)
// - UI(index.html)はエージェント詳細パネルに 使用/上限/残り+バー を表示する
// トークン換算は engine/compact.js の estimateTokens と同じ「文字数/3(切り上げ)」で統一する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";

tokenedFetchOn();

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-ctxwin-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

async function setup() {
  const ws = mktmp();
  const bus = new Bus();
  const config = {
    workspace: ws,
    ui: { port: 0 },
    model: { model: "test", contextWindow: 200000 },
    agents: [],
    budget: { maxTokensPerRun: 1 },
  };
  const ui = await startUiTokenized(startUi, {
    config, modelFactory: () => ({}), bus, autoStart: false,
  });
  const base = `http://127.0.0.1:${config.ui.port}`;
  const getState = async () => (await (await fetch(`${base}/api/state`)).json());
  return { ws, bus, ui, getState };
}

test("loop.jsはusage-trace記録時にusage.traceイベントを発行する", () => {
  const src = readFileSync(join(repoRoot, "src/engine/loop.js"), "utf8");
  assert.match(src, /bus\.emit\("usage\.trace"/);
  // ctxChars(コンテキスト概算文字数)をイベントへ載せる
  assert.match(src, /ctxChars/);
});

test("server: usage.traceを受けると/api/stateのagent.ctxに使用/上限/残りが入る", async () => {
  const { bus, ui, getState, ws } = await setup();
  try {
    // 未登録エージェントでも usage.trace で出現する(表示が消えない)
    bus.emit("usage.trace", { agent: "worker-a", turn: 1, ctxChars: 3000 });
    const st = await getState();
    const ctx = st.live.agents["worker-a"]?.ctx;
    assert.ok(ctx, "agent.ctxが存在する");
    assert.equal(ctx.ctxChars, 3000);
    // 文字数/3(切り上げ)でトークン換算: 3000文字 → 1000tok
    assert.equal(ctx.usedTokens, 1000);
    assert.equal(ctx.ctxWindow, 200000);
    assert.equal(ctx.remainTokens, 199000);
  } finally { ui.close(); rmTree(ws); }
});

test("server: 換算は切り上げ・ctxWindow未設定時は200Kフォールバック・ゼロ除算安全", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = {
    workspace: ws, ui: { port: 0 },
    model: { model: "test" }, // contextWindow無し
    agents: [], budget: { maxTokensPerRun: 1 },
  };
  const ui = await startUiTokenized(startUi, {
    config, modelFactory: () => ({}), bus, autoStart: false,
  });
  const base = `http://127.0.0.1:${config.ui.port}`;
  try {
    bus.emit("usage.trace", { agent: "w2", turn: 2, ctxChars: 7 });
    const st = await (await fetch(`${base}/api/state`)).json();
    const ctx = st.live.agents["w2"].ctx;
    assert.equal(ctx.usedTokens, Math.ceil(7 / 3)); // 3
    assert.equal(ctx.ctxWindow, 200000);
    assert.equal(ctx.remainTokens, 200000 - 3);
  } finally { ui.close(); rmTree(ws); }
});

test("server: 上限超過時は残り0・usage.trace更新で上書きされる(リアルタイム)", async () => {
  const { bus, ui, getState, ws } = await setup();
  try {
    bus.emit("usage.trace", { agent: "w3", turn: 1, ctxChars: 700000 });
    let st = await getState();
    assert.equal(st.live.agents["w3"].ctx.remainTokens, 0);
    bus.emit("usage.trace", { agent: "w3", turn: 2, ctxChars: 9000 });
    st = await getState();
    assert.equal(st.live.agents["w3"].ctx.usedTokens, 3000);
    assert.equal(st.live.agents["w3"].ctx.remainTokens, 197000);
  } finally { ui.close(); rmTree(ws); }
});

test("UI: 詳細パネルにコンテキスト使用量(使用/上限/残り+バー)の描画がある", () => {
  const html = readFileSync(join(repoRoot, "src/ui/public/index.html"), "utf8");
  // 詳細パネル(renderAgentLog)内でa.ctxを参照する
  assert.match(html, /a\.ctx/);
  // 使用/上限/残りの表示(トークン換算済みの値をそのまま出す)
  assert.match(html, /コンテキスト/);
  assert.match(html, /usedTokens/);
  assert.match(html, /remainTokens/);
  // バー描画(fill幅を占有率で設定)
  assert.match(html, /ctx-fill/);
  // バーおよび警告色(.hot)のCSSが定義済み(視覚的に機能するバーであること)
  assert.match(html, /\.ctxbar\s*\{[^}]*height\s*:/);
  assert.match(html, /\.ctx-fill\s*\{[^}]*width\s*:/);
  assert.match(html, /\.ctx-fill\.hot/);
});
