// モデル選択ポリシー(イシュー#12の仕組み化)の検証。
// (a) MODEL_SELECTION_POLICYがシステムプロンプトに乗る
// (b) readModelPolicy: config未設定は既定値/上書きでしきい値・モデルが変わる
// (c) noteRejection: 差し戻し2回でエスカレーション推奨文面が出る(1回では出ない)
// (d) 推奨文面にはクォータ保護が含まれる
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/engine/loop.js";
import {
  DEFAULT_ESCALATION_THRESHOLD,
  DEFAULT_ESCALATE_MODEL,
  MODEL_SELECTION_POLICY,
  QUOTA_NOTE,
  readModelPolicy,
  noteRejection,
  rejectionCount,
} from "../src/engine/model-policy.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-policy-"));
}

test("モデル選択ポリシー文面がシステムプロンプトに乗る", () => {
  const agent = { id: "a1", displayName: "テスト", role: "impl", personaText: "# ペルソナ" };
  const p = buildSystemPrompt(agent, "bash");
  assert.ok(p.includes("モデル選択ポリシー"), "ポリシー見出しが含まれる");
  assert.ok(p.includes(MODEL_SELECTION_POLICY.trim().split("\n")[1].trim().slice(0, 20)), "本文も連結される");
  // 環境セクションより前に出る(COMMON_RULESの末尾に差し込む形)
  assert.ok(p.indexOf("モデル選択ポリシー") < p.indexOf("このマシンの環境"));
});

test("readModelPolicy: config未設定は既定値(しきい値2・モデルnull)", () => {
  const p = readModelPolicy(null);
  assert.equal(p.escalationThreshold, DEFAULT_ESCALATION_THRESHOLD);
  assert.equal(p.escalateModel, DEFAULT_ESCALATE_MODEL);
  assert.equal(readModelPolicy({}).escalationThreshold, DEFAULT_ESCALATION_THRESHOLD);
});

test("readModelPolicy: chat.modelPolicyで上書きできる(不正値は既定へフォールバック)", () => {
  const p = readModelPolicy({ chat: { modelPolicy: { escalationThreshold: 3, escalateModel: "zai/glm-5.3" } } });
  assert.equal(p.escalationThreshold, 3);
  assert.equal(p.escalateModel, "zai/glm-5.3");
  const bad = readModelPolicy({ chat: { modelPolicy: { escalationThreshold: 0, escalateModel: "  " } } });
  assert.equal(bad.escalationThreshold, DEFAULT_ESCALATION_THRESHOLD);
  assert.equal(bad.escalateModel, DEFAULT_ESCALATE_MODEL);
});

test("noteRejection: しきい値未満はnull・2回でエスカレーション推奨が出る", () => {
  const ws = mktmp();
  try {
    const r1 = noteRejection(ws, "task-x", null);
    assert.equal(r1.count, 1);
    assert.equal(r1.notice, null, "1回目は推奨しない");
    const r2 = noteRejection(ws, "task-x", null);
    assert.equal(r2.count, 2);
    assert.ok(r2.notice, "2回目(しきい値到達)で推奨文面が出る");
    assert.match(r2.notice, /モデル選択エスカレーション推奨/);
    assert.match(r2.notice, /task-x/);
    assert.match(r2.notice, /2 回/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("エスカレーション推奨にはクォータ保護と再起票案内が含まれる", () => {
  const ws = mktmp();
  try {
    noteRejection(ws, "task-q", null);
    const { notice } = noteRejection(ws, "task-q", null);
    assert.ok(notice.includes(QUOTA_NOTE), "同時1タスク制限を含む");
    assert.match(notice, /再起票/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("rejectionCount: タスク別に独立して数える(未記録は0)", () => {
  const ws = mktmp();
  try {
    assert.equal(rejectionCount(ws, "task-a"), 0);
    noteRejection(ws, "task-a", null);
    noteRejection(ws, "task-b", null);
    assert.equal(rejectionCount(ws, "task-a"), 1);
    assert.equal(rejectionCount(ws, "task-b"), 1);
    assert.equal(rejectionCount(ws, "task-c"), 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("しきい値をconfigで3に上げると3回目まで推奨が出ない", () => {
  const ws = mktmp();
  try {
    const cfg = { chat: { modelPolicy: { escalationThreshold: 3 } } };
    assert.equal(noteRejection(ws, "task-y", cfg).notice, null);
    assert.equal(noteRejection(ws, "task-y", cfg).notice, null);
    const r3 = noteRejection(ws, "task-y", cfg);
    assert.equal(r3.count, 3);
    assert.ok(r3.notice, "3回目で推奨");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
