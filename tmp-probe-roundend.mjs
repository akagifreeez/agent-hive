import { Hooks } from "./src/engine/hooks.js";
import { ChatHost } from "./src/engine/chat.js";
import { Bus } from "./src/engine/bus.js";
import { Board } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { createTools } from "./src/engine/tools.js";
import { mktmp, rmTree } from "./test/helpers/tmp.js";
import { join } from "node:path";

const ws = mktmp(); const ws2 = mktmp();
const t0 = Date.now();
const hooks = new Hooks({ config: { hooks: { roundEnd: `node -e "const fs=require('fs');fs.appendFileSync('rounds.txt', process.env.HIVE_HOOK_AGENT + ':' + Date.now())"` } }, cwd: ws2 });
const bus = new Bus();
const board = new Board(bus, "s");
const tasks = new TaskBlackboard(ws, bus);
const tools = createTools({ agent: { id: "s-alpha", displayName: "アルファ", role: "impl", personaText: "# S" }, workspace: ws, board, tasks, bus });
const model = { maxTokens: 4000, async chat() { return { content: "完了", toolCalls: [], raw: { content: "完了" }, usage: { promptTokens: 10, completionTokens: 1 } }; } };
bus.on("thread.round.end", (e) => console.log("roundEnd-event t+", Date.now()-t0, JSON.stringify(e)));
const host = new ChatHost({ mains: [{ id: "s-alpha", displayName: "アルファ", role: "impl", personaText: "# S" }], project: "s", hooks, maxTurnsPerRound: 3, staggerMs: 0, modelFactory: () => model, toolsFactory: () => tools, board, tasks, bus });
const tSay = Date.now();
host.say("始めて");
// hooks.runの内部時刻を知りたいので、フック実行前後をラップ
const origRun = hooks.run.bind(hooks);
hooks.run = async (name, env) => { console.log("hook-run start t+", Date.now()-t0); const r = await origRun(name, env); console.log("hook-run end t+", Date.now()-t0); return r; };
const start = Date.now();
while (Date.now() - start < 12000) {
  try { const c = (await import("node:fs")).readFileSync(join(ws2, "rounds.txt"), "utf8"); if (c) { console.log("file written t+", Date.now()-t0, JSON.stringify(c)); break; } } catch {}
  await new Promise(r=>setTimeout(r,100));
}
console.log("elapsed-say-to-start t+", tSay - t0);
rmTree(ws); rmTree(ws2);
process.exit(0);
