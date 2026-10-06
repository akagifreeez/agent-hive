import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAgentWork } from "../src/engine/worktree.js";

test("mergeAgentWork: 作業フォルダー未設定では現在のフォルダーでgitを実行しない", async () => {
  for (const paths of [
    { mainWorkspace: "/main" },
    { mainWorkspace: "/main", worktreePath: "" },
    { mainWorkspace: "/main", worktreePath: "   " },
    { mainWorkspace: "", worktreePath: "/worker" },
  ]) {
    const calls = [];
    const result = await mergeAgentWork({
      ...paths, agent: { id: "alpha" }, taskId: "chat-round",
      exec: async (args) => { calls.push(args); return { ok: false, text: "exit=1\n" }; },
    });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0, "フォルダーが未設定ならgitを実行しない");
    assert.match(result.text, /未設定/);
  }
});
