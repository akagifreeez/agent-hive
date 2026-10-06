// 診断: spawn-chat テストの「brief駆動→finish→mainマージ」を再現し、busイベントと経過を出す
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { SpawnManager } from "./src/engine/spawn.js";
import { ensureGitRepo } from "./src/engine/discover.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ws = mkdtempSync(join(tmpdir(), "hive-diag-"));
const root = `${ws}-wt`;
const bus = new Bus();
const board = new Board(bus);
const tasks = new TaskBlackboard(ws, bus);
const t0 = Date.now();
const log = (...a) => console.log(`${String(Date.now() - t0).padStart(6)}ms`, ...a);

bus.onAny?.((ev, data) => log(`[bus] ${ev}`, JSON.stringify(data)?.slice(0, 200)));

await ensureGitRepo(ws);

let i = 0;
const scriptedModel = (script) => ({
  maxTokens: 4000,
  async chat({ messages }) {
    const step = script[Math.min(i++, script.length - 1)];
    log(`model.chat #${i} → ${step.toolCalls ? step.toolCalls.map((t) => t.name).join(",") : step.text?.slice(0, 30)}`);
    return {
      content: step.text ?? null,
      toolCalls: (step.toolCalls ?? []).map((tc, j) => ({ id: `c${i}-${j}`, name: tc.name, arguments: tc.args ?? {} })),
      raw: { role: "assistant", content: step.text ?? null, tool_calls: [] },
      usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.0001 },
    };
  },
});

const manager = new SpawnManager({
  mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
  hierarchy: { maxDepth: 2, maxConcurrent: 6 },
  modelFactory: (agent) => scriptedModel([
    { toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "サブの成果" } }] },
    { toolCalls: [{ name: "finish_task", args: { task_id: `spawn-${agent.id}` } }] },
    { text: "作業を完了しました" },
  ]),
});

const r = await manager.spawn({ parent: { id: "alpha", displayName: "アルファ", depth: 0 }, brief: "out.txtを作って", role: "impl" });
log("spawned:", r.id, r.error ?? "");

for (let s = 0; s < 30; s++) {
  await new Promise((res) => setTimeout(res, 1000));
  const snap = manager.snapshot()[r.id];
  const claimed = tasks.claimedBy(r.id).map((t) => t.id);
  log(`t+${s}s status=${snap?.status} claimed=[${claimed}] out.txt=${existsSync(join(ws, "out.txt"))} wt=${existsSync(join(root, r.id))}`);
  if (snap?.status === "done" || String(snap?.status ?? "").startsWith("ended")) break;
}
const snap = manager.snapshot()[r.id];
log("final:", snap?.status);
try { log("board posts:", board.posts.map((p) => `${p.from}:${p.text.slice(0, 60)}`).join(" | ")); } catch {}
try { rmSync(ws, { recursive: true, force: true }); } catch {}
try { rmSync(root, { recursive: true, force: true }); } catch {}
process.exit(0);
