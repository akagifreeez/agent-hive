import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { ChatHost } from "./src/engine/chat.js";
import { createTools } from "./src/engine/tools.js";

const ws = mkdtempSync(join(tmpdir(), "hive-probe-"));
const bus = new Bus();
const board = new Board(bus, "unsub");
const tasks = new TaskBlackboard(ws, bus);
const agent = { id: "unsub-alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
let chats = 0;
const model = { maxTokens: 100, async chat() { chats++; return { content: "ok", toolCalls: [], raw: { content: "ok" }, usage: {} }; } };
const host = new ChatHost({
  mains: [agent], project: "unsub", autoContinueRounds: 0, staggerMs: 0,
  modelFactory: () => model,
  toolsFactory: () => createTools({ agent, workspace: ws, board, tasks, bus }),
  board, tasks, bus,
});
board.post("beta-9", "@アルファ 生きていますか");
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 100));
  if (chats > 0) break;
}
console.log("chats after 4s:", chats);
host.unsubscribe();
board.post("beta-9", "@アルファ ゴースト起床はしない");
await new Promise((r) => setTimeout(r, 500));
console.log("chats after unsub post:", chats);
rmSync(ws, { recursive: true, force: true });
