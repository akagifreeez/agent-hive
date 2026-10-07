// モデル可視バンドルの裏ログ(G1・dsh-vs-hive比較doc):
// モデル呼出1回ごとに組立済みペイロード(system+messages+tools)と応答/失敗が
// state/session-log/session.jsonlへ1行で残ること。圧縮要約の呼出も同様。回転も検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, Board } from "../src/engine/board.js";
import { runAgentLoop } from "../src/engine/loop.js";
import { createSessionLog, SESSION_LOG_MAX_BYTES } from "../src/engine/session-log.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-sessionlog-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

function readRecords(dir) {
  return readFileSync(join(dir, "session.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function mkBoard(ws, bus) {
  const stateDir = join(ws, "state");
  mkdirSync(stateDir, { recursive: true });
  return new Board(bus, "sl", join(stateDir, "board__sl__.jsonl"));
}

test("session-log: 主呼出の組立済みペイロードと応答が1レコードで残る", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = mkBoard(ws, bus);
  const specs = [{ name: "noop", description: "何もしない", parameters: { type: "object", properties: {} } }];
  const model = {
    maxTokens: 100,
    async chat() {
      return { content: "最終応答", toolCalls: [], raw: {}, usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0 } };
    },
  };
  const agent = { id: "sl-1", displayName: "エス", role: "impl", personaText: "# S" };
  const r = await runAgentLoop({
    agent, model, tools: { specs, execute: async () => ({ ok: true, text: "" }) },
    board, tasks: null, bus, maxTurns: 3,
  });
  assert.equal(r.ok, true);
  const dir = join(ws, "state", "session-log");
  const records = readRecords(dir);
  assert.equal(records.length, 1, "主呼出1回につき1レコード");
  const rec = records[0];
  assert.equal(rec.kind, "chat");
  assert.equal(rec.agent, "sl-1");
  assert.equal(rec.turn, 1);
  assert.equal(rec.request.messages[0].role, "system");
  assert.ok(rec.request.messages.some((m) => m.role === "user"), "kickoffが記録される");
  assert.deepEqual(rec.request.tools, specs, "ツール定義そのものが記録される");
  assert.equal(rec.response.content, "最終応答");
  assert.equal(rec.response.usage.promptTokens, 10);
  assert.equal(rec.error, undefined);
  assert.equal(typeof rec.ms, "number");
  assert.ok(rec.ts);
  // G9: usage-trace.jsonlにもcached列が載る(未報告はnull)
  const trace = JSON.parse(readFileSync(join(ws, "state", "usage-trace", "usage-trace.jsonl"), "utf8").trim());
  assert.equal(trace.cached, null);
  assert.equal(trace.prompt, 10);
  rmTree(ws);
});

test("session-log: モデルエラーの呼出もattemptとして残る", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = mkBoard(ws, bus);
  const model = {
    maxTokens: 100,
    async chat() { throw new Error("モデルAPIが死んだ(テスト)"); },
  };
  const agent = { id: "sl-2", displayName: "ドウ", role: "impl", personaText: "# S" };
  const r = await runAgentLoop({
    agent, model, tools: { specs: [], execute: async () => ({ ok: true, text: "" }) },
    board, tasks: null, bus, maxTurns: 3,
  });
  assert.equal(r.endedBy, "error");
  const records = readRecords(join(ws, "state", "session-log"));
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "chat");
  assert.ok(records[0].error.includes("モデルAPIが死んだ(テスト)"));
  assert.equal(records[0].response, undefined, "失敗attemptにはresponseが無い");
  assert.ok(records[0].request.messages.length >= 2, "失敗時のペイロードも記録される");
  rmTree(ws);
});

test("session-log: 圧縮要約の呼出がcompactレコードとして残る(圧縮前の全履歴込み)", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = mkBoard(ws, bus);
  let n = 0;
  const model = {
    maxTokens: 100,
    async chat() {
      n++;
      if (n === 1) return { content: "1ターン目の作業報告", toolCalls: [], raw: {}, usage: { promptTokens: 250000, completionTokens: 10, reasoningTokens: 0, costUsd: 0 } };
      if (n === 2) return { content: "要約文です", toolCalls: [], raw: {}, usage: { promptTokens: 5, completionTokens: 2, reasoningTokens: 0, costUsd: 0 } };
      return { content: "圧縮後の最終応答", toolCalls: [], raw: {}, usage: { promptTokens: 12, completionTokens: 3, reasoningTokens: 0, costUsd: 0 } };
    },
  };
  const agent = { id: "sl-3", displayName: "シミ", role: "impl", personaText: "# S" };
  const r = await runAgentLoop({
    agent, model, tools: { specs: [], execute: async () => ({ ok: true, text: "" }) },
    board, tasks: null, bus, maxTurns: 6, contextWindow: 200000,
  });
  assert.equal(r.ok, true);
  const records = readRecords(join(ws, "state", "session-log"));
  const kinds = records.map((x) => x.kind);
  assert.deepEqual(kinds, ["chat", "compact", "chat"], "主呼出→圧縮要約→圧縮後の主呼出の順に残る");
  const compactRec = records[1];
  assert.equal(compactRec.response.content, "要約文です");
  assert.ok(Array.isArray(compactRec.request.messages) && compactRec.request.messages.length > 0, "要約の入力(圧縮前の履歴)が記録される");
  assert.ok(records[2].request.messages.some((m) => String(m.content ?? "").includes("要約文です")), "圧縮後の主呼出には要約が入っている");
  rmTree(ws);
});

test("session-log: 上限到達で回転し、旧ファイルはkeep枚まで残る", () => {
  const dir = join(mktmp(), "session-log");
  const log = createSessionLog({ dir, maxBytes: 300, keep: 2 });
  for (let i = 0; i < 6; i++) {
    log.append({ n: i, pad: "x".repeat(80) });
  }
  assert.ok(existsSync(join(dir, "session.jsonl")), "現行ファイルが常に存在する");
  const rotated = readdirSync(dir).filter((f) => /^session-\d{4}-\d{2}-\d{2}T/.test(f));
  assert.ok(rotated.length <= 2, `旧ファイルはkeep枚まで(${rotated.length})`);
  assert.ok(log.rotations() > 0, "回転が発生している");
  const lines = readFileSync(join(dir, "session.jsonl"), "utf8").trim().split("\n");
  assert.ok(lines.length >= 1);
});

test("session-log: dir無しはno-opで例外も出さない", () => {
  const log = createSessionLog({ dir: null });
  assert.doesNotThrow(() => log.append({ a: 1 }));
  assert.equal(log.rotations(), 0);
});

test("session-log: 既定上限は64MB(実運用の回転しきい値が変わっていないことの固定)", () => {
  assert.equal(SESSION_LOG_MAX_BYTES, 64 * 1024 * 1024);
});
