import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { SpawnManager } from "./src/engine/spawn.js";
import { ensureGitRepo } from "./src/engine/discover.js";

const ws = mkdtempSync(join(tmpdir(), "hive-dbg-"));
await ensureGitRepo(ws);
const bus = new Bus(); const board = new Board(bus); const tasks = new TaskBlackboard(ws, bus);
bus.on("agent.status", (e) => console.log("STATUS", e.agent, e.status));
bus.on("tool.result", (e) => console.log("TOOL", e.agent, e.tool, e.ok, (e.brief ?? "").slice(0, 80)));
const usage = { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.0001 };
const mgr = new SpawnManager({ mainWorkspace: ws, worktreeRoot: ws + "-wt", board, tasks, bus, hierarchy: { maxDepth: 2, maxConcurrent: 6 },
  modelFactory: () => ({ maxTokens: 4000, async chat({ messages }) {
    const last = String(messages[messages.length - 1].content ?? "");
    console.log("TURN last:", last.slice(0, 60).replace(/\n/g, " "));
    if (last.includes("finish_task を呼んで")) {
      return { content: null, toolCalls: [{ id: "c3", name: "claim_next_task", arguments: {} }], raw: { role: "assistant", content: null, tool_calls: [] }, usage };
    }
    if (last.includes("請求できるタスクはありません")) {
      return { content: "終了します", toolCalls: [], raw: { role: "assistant", content: "終了します", tool_calls: [] }, usage };
    }
    if (last.includes("create_task")) return { content: "起票しました", toolCalls: [], raw: { role: "assistant", content: "起票しました", tool_calls: [] }, usage };
    return { content: null, toolCalls: [{ id: "c1", name: "create_task", arguments: { task_id: "spawn-impl-99-followup", body: "x", project: "t" } }], raw: { role: "assistant", content: null, tool_calls: [] }, usage };
  } })
});
const r = await mgr.spawn({ parent: { id: "alpha", displayName: "A", depth: 0 }, brief: "test", role: "impl", expendable: true });
console.log("spawned", r);
await new Promise((res) => setTimeout(res, 15000));
console.log("snapshot", JSON.stringify(mgr.snapshot()));
console.log("tasks", JSON.stringify(tasks.snapshot()));
rmSync(ws, { recursive: true, force: true }); rmSync(ws + "-wt", { recursive: true, force: true });
process.exit(0);
