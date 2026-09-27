import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { SpawnManager } from "./src/engine/spawn.js";
import { ensureGitRepo } from "./src/engine/discover.js";

const ws = mkdtempSync(join(tmpdir(), "hive-dbg2-"));
const root = `${ws}-wt`;
const bus = new Bus();
const board = new Bus() && new Board(bus);
const tasks = new TaskBlackboard(ws, bus);
await ensureGitRepo(ws);
bus.on("tool.call", (e)=>console.log("TOOLCALL", e.tool, JSON.stringify(e.args)));
bus.on("tool.result", (e)=>console.log("TOOLRES", e.tool, e.ok, e.brief));
const manager = new SpawnManager({
  mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
  hierarchy: { maxDepth: 2, maxConcurrent: 6 },
  modelFactory: (agent) => ({
    maxTokens: 4000,
    async chat({ messages }) {
      const last = String(messages[messages.length - 1].content ?? "");
      if (last.includes("create_task")) {
        return { content: "起票しました", toolCalls: [], raw: { role: "assistant", content: "起票しました", tool_calls: [] }, usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.0001 } };
      }
      return { content: null, toolCalls: [{ id: "c1", name: "create_task", arguments: { task_id: `spawn-${agent.id}-followup`, body: "後続の仕事", project: "t" } }], raw: { role: "assistant", content: null, tool_calls: [] }, usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.0001 } };
    },
  }),
});
const main = { id: "alpha", displayName: "アルファ", depth: 0 };
const r = await manager.spawn({ parent: main, brief: "追加仕事の起票だけして終わる", role: "impl", expendable: true });
for (let i=0;i<30;i++){ await new Promise(res=>setTimeout(res,500)); const s=manager.snapshot()[r.id]; if(s?.status==="done"||String(s?.status).startsWith("ended")) { console.log("FINAL", s?.status); break; } }
console.log("open:", tasks.snapshot().open, "done:", tasks.snapshot().done);
rmSync(ws,{recursive:true,force:true}); try{rmSync(root,{recursive:true,force:true});}catch{}
