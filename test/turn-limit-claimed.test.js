// turn-limit到達時の宙吊り防止: 仕掛かり中タスクが残ったままturn-limitで抜けるとき、
// 担当者が消える終わり方(予算停止/モデルエラー)と同じ releaseClaims 導線でopenへ戻す。
// 実例(blog lab): impl-ogp 完了後に impl-pagefind を請求→turn-limit到達でタスク宙吊り→
// open解放も報告もされず担い手不在(自動解放に頼っていた)。この回帰を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { runAgentLoop } from "../src/engine/loop.js";

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");

const stateOf = (tasks, id) => tasks.list().open.find((t) => t.id === id) ?? tasks.list().claimed.find((t) => t.id === id) ?? tasks.list().done.find((t) => t.id === id);

// blog lab実例の再現: turn 1でページ作成(仕掛かりタスクを持ったまま最終応答)、
// 次ターンが回らないままturn-limit到達 → finishせずタスクだけ宙吊りになる
test("turn-limit: 仕掛かり中タスクが宙吊りにならずopenへ戻り、報告も投稿される", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-turnlimit-"));
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };
  const tools = {
    specs: [{ name: "noop", description: "何もしない", parameters: { type: "object" } }],
    execute: async () => ({ ok: true, text: "ok" }),
  };
  await tasks.create({ id: "impl-ogp", body: "OGPを追加" });
  await tasks.create({ id: "impl-pagefind", body: "pagefindを追加" });
  tasks.claim(agent, { project: null });
  tasks.claim(agent, {});
  assert.deepEqual(tasks.claimedBy(agent.id).map((t) => t.id).sort(), ["impl-ogp", "impl-pagefind"]);

  // turn 1: ツール実行(作業途中)。turn 2: テキストのみで終了しようとする(=finishしない)。
  // maxTurns=2 で「2ターン目の最終応答後に上限到達」を再現する。
  const turns = [
    {
      content: "ファイルを読みます",
      toolCalls: [{ id: "t1", name: "noop", arguments: {} }],
      raw: { stop_reason: "tool_use", blocks: [{ type: "tool_use", id: "t1", name: "noop", input: {} }] },
      usage: { promptTokens: 1, completionTokens: 1 },
    },
    {
      content: "途中ですが上がります",
      raw: { stop_reason: "end_turn", blocks: [{ type: "text", text: "途中ですが上がります" }] },
      usage: { promptTokens: 1, completionTokens: 1 },
    },
  ];
  const model = {
    maxTokens: 4000,
    async chat() {
      const t = turns.shift() ?? turns[turns.length - 1];
      return { content: t.content, reasoning: null, toolCalls: t.toolCalls ?? [], raw: t.raw, usage: t.usage, searches: null };
    },
  };
  const statuses = [];
  bus.on("agent.status", (e) => statuses.push(e.status));
  try {
    const r = await runAgentLoop({ agent, model, tools, board, tasks, bus, maxTurns: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.endedBy, "turn-limit");
    assert.equal(statuses.includes("turn-limit"), true, "turn-limitステータスが通知される");
    // 宙吊り防止: 仕掛かり中タスクがreleaseされ、誰でも請求できるopenへ戻る
    assert.deepEqual(tasks.claimedBy(agent.id), [], "仕掛かり中タスクが残らない(宙吊り防止)");
    for (const id of ["impl-ogp", "impl-pagefind"]) {
      const t = stateOf(tasks, id);
      assert.equal(t?.state, "open", `${id} がopenへ戻る(実際: ${t?.state})`);
      assert.equal(t?.agent, null, `${id} の担当者が外れる`);
    }
    // 導線の見える化: 担当者不在をボードへ報告
    const release = board.posts.map((p) => `${p.from}: ${p.text}`).find((s) => s.includes("[解放]") && s.includes("impl-pagefind") && s.includes("impl-ogp"));
    assert.ok(release, "解放報告がボードに投稿される");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// 対照: finish_task で正しく完了したタスクは宙吊りではなくdoneのまま
test("turn-limit: finish済みタスクはopenへ戻さない(通常完了と併存する)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-turnlimit-done-"));
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };
  const tools = {
    specs: [{ name: "noop", description: "何もしない", parameters: { type: "object" } }],
    execute: async () => ({ ok: true, text: "ok" }),
  };
  await tasks.create({ id: "impl-first", body: "1つ目" });
  await tasks.create({ id: "impl-second", body: "2つ目" });
  tasks.claim(agent, {});
  tasks.claim(agent, {});
  tasks.finish(agent, "impl-first"); // blog実例: impl-ogpは完了済み・次のimpl-pagefindで落ちるパターン

  const turns = [
    {
      content: "作業します",
      toolCalls: [{ id: "t1", name: "noop", arguments: {} }],
      raw: { stop_reason: "tool_use", blocks: [{ type: "tool_use", id: "t1", name: "noop", input: {} }] },
      usage: { promptTokens: 1, completionTokens: 1 },
    },
    {
      content: "上がります",
      raw: { stop_reason: "end_turn", blocks: [{ type: "text", text: "上がります" }] },
      usage: { promptTokens: 1, completionTokens: 1 },
    },
  ];
  const model = {
    maxTokens: 4000,
    async chat() {
      const t = turns.shift() ?? turns[turns.length - 1];
      return { content: t.content, reasoning: null, toolCalls: t.toolCalls ?? [], raw: t.raw, usage: t.usage, searches: null };
    },
  };
  try {
    const r = await runAgentLoop({ agent, model, tools, board, tasks, bus, maxTurns: 2 });
    assert.equal(r.endedBy, "turn-limit");
    assert.equal(tasks.claimedBy(agent.id).length, 0, "仕掛かりはゼロ");
    assert.equal(stateOf(tasks, "impl-first")?.state, "done", "完了済みはdoneのまま");
    assert.equal(stateOf(tasks, "impl-second")?.state, "open", "未完了だけがopenへ戻る");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
