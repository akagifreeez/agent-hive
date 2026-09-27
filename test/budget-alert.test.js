// usage予算アラート: config.chat.budgetAlertUsd(累積コスト$のしきい値)超過で
// メインボードへ1回だけ告知し、以後は告知しない。usage.round(ラウンド終了ごとの
// 台帳累積)をトリガにする。ステータスライン表示用に累積コストを /api/state へ配る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";

tokenedFetchOn();

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-budgetalert-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

async function setup({ budgetAlertUsd } = {}) {
  const ws = mktmp();
  const bus = new Bus();
  const config = {
    workspace: ws,
    ui: { port: 0 },
    model: { model: "test" },
    agents: [],
    budget: { maxTokensPerRun: 1 },
    chat: budgetAlertUsd == null ? {} : { budgetAlertUsd },
  };
  const ui = await startUiTokenized(startUi, {
    config, modelFactory: () => ({}), bus, autoStart: false,
  });
  const base = `http://127.0.0.1:${config.ui.port}`;
  const getState = async () => (await (await fetch(`${base}/api/state`)).json());
  return { ws, bus, ui, getState };
}

test("budgetAlertUsd: 累積コストがしきい値を初めて超えたらメインボードに1回だけ告知", async () => {
  const { ws, bus, ui, getState } = await setup({ budgetAlertUsd: 1 });
  try {
    // ラウンド1: 累積$0.4 → まだ超えていない(告知なし)
    bus.emit("usage.round", { agent: "lead", endedBy: "ok", totals: { calls: 2, costUsd: 0.4 } });
    let st = await getState();
    let alert = (st.live.board ?? []).filter((p) => (p.text ?? "").includes("予算超過"));
    assert.equal(alert.length, 0, "超過前は告知しない");
    assert.equal(st.live.budget?.exceeded ?? false, false, "超過前フラグはfalse");

    // ラウンド2: 累積$1.4 → 初回超過。1回だけ告知
    bus.emit("usage.round", { agent: "lead", endedBy: "ok", totals: { calls: 4, costUsd: 1.4 } });
    st = await getState();
    alert = (st.live.board ?? []).filter((p) => (p.text ?? "").includes("予算超過"));
    assert.equal(alert.length, 1, "初回超過で1件の告知");
    assert.ok(alert[0].text.includes("累積$1.40"), `告知文に累積額を含む: ${alert[0].text}`);
    assert.equal(alert[0].thread ?? "__main__", "__main__", "メインボード宛て");
    assert.equal(st.live.budget.exceeded, true, "超過フラグが立つ");

    // ラウンド3: 累積$2.9 → 2回目以降は告知しない
    bus.emit("usage.round", { agent: "lead", endedBy: "ok", totals: { calls: 6, costUsd: 2.9 } });
    st = await getState();
    alert = (st.live.board ?? []).filter((p) => (p.text ?? "").includes("予算超過"));
    assert.equal(alert.length, 1, "2回目の告知はしない");

    // /api/state 経由で累積コストがUIへ配られる(ステータスライン用)
    assert.equal(st.live.budget.costUsd, 2.9);
    assert.equal(st.live.budget.thresholdUsd, 1);
  } finally {
    ui.close();
    rmTree(ws);
  }
});

test("budgetAlertUsd: 未設定(省略)なら告知もstate配布もしない", async () => {
  const { ws, bus, ui, getState } = await setup({});
  try {
    bus.emit("usage.round", { agent: "lead", endedBy: "ok", totals: { calls: 1, costUsd: 999 } });
    const st = await getState();
    const alert = (st.live.board ?? []).filter((p) => (p.text ?? "").includes("予算超過"));
    assert.equal(alert.length, 0, "しきい値未設定なら告知しない");
    assert.equal(st.live.budget?.costUsd ?? 0, 0, "未設定時は累積コストを配らない");
  } finally {
    ui.close();
    rmTree(ws);
  }
});

test("budgetAlertUsd: 境界値(累積==しきい値)は超過とみなさない", async () => {
  const { ws, bus, ui, getState } = await setup({ budgetAlertUsd: 1 });
  try {
    bus.emit("usage.round", { agent: "lead", endedBy: "ok", totals: { calls: 1, costUsd: 1 } });
    const st = await getState();
    const alert = (st.live.board ?? []).filter((p) => (p.text ?? "").includes("予算超過"));
    assert.equal(alert.length, 0, "しきい値ちょうど(==)はまだ超過でない");
    assert.equal(st.live.budget.exceeded, false);
  } finally {
    ui.close();
    rmTree(ws);
  }
});
