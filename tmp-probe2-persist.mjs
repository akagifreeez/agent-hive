// 一時プローブ2: run2の全busイベントを記録し、3ワーカー起床の引き金を特定する
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "./src/engine/board.js";
import { runChat } from "./src/runner.js";

const ws = mkdtempSync(join(tmpdir(), "hive-probe2-"));
const config = {
  workspace: ws,
  worktrees: { dir: `${ws}-wt` },
  model: { contextWindow: 200000, maxTokens: 4000 },
  loop: { maxTurns: 10 },
  budget: null,
  compact: { thresholdPercent: 90 },
  discovery: {},
  permissions: {},
  scenario: { name: "test" },
  chat: { lead: "lead", workers: ["alpha", "beta", "gamma"], maxTurnsPerRound: 8, staggerMs: 5, autoscale: false },
  agents: [
    { id: "alpha", displayName: "アルファ", role: "impl" },
    { id: "beta", displayName: "ベータ", role: "review" },
    { id: "gamma", displayName: "ガンマ", role: "impl" },
  ],
};
const modelFactory = () => ({
  maxTokens: 4000,
  async chat() {
    return { content: "承知しました", reasoning: null, toolCalls: [], raw: null, usage: { promptTokens: 10, completionTokens: 1 }, searches: null };
  },
});
const waitUntil = async (fn, ms = 20000) => { const s = Date.now(); while (Date.now() - s < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return fn(); };
const lines = () => existsSync(join(ws, "state", "board-demo.jsonl")) ? readFileSync(join(ws, "state", "board-demo.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length : 0;

try {
  const ctl1 = await runChat({ config, bus: new Bus(), modelFactory });
  ctl1.say("こんにちは");
  await waitUntil(() => lines() >= 2, 15000);
  await ctl1.openThread({ project: "demo", goal: "復元テスト" });
  await waitUntil(() => ctl1.listThreads().includes("demo"));
  let prev = -1, stable = 0;
  for (let i = 0; i < 100; i++) {
    const c = lines();
    if (c === prev && c > 0) { stable++; if (stable >= 5) break; } else stable = 0;
    prev = c;
    await new Promise((r) => setTimeout(r, 200));
  }
  const before = lines();
  console.log("=== BEFORE lines=", before);
  const bus2 = new Bus();
  const rawEmit = bus2.emit.bind(bus2);
  bus2.emit = (type, payload) => {
    try {
      const th = payload?.thread ?? payload?.name ?? payload?.board?.name ?? "";
      let extra = "";
      if (type === "board") extra = ` from=${payload.from} text=${JSON.stringify((payload.text ?? "").slice(0, 60))}`;
      if (String(type).includes("task")) extra = ` ${JSON.stringify(payload).slice(0, 120)}`;
      console.log(`[EV] ${type}${extra} (th=${th})`);
    } catch {}
    rawEmit(type, payload);
  };
  await runChat({ config, bus: bus2, modelFactory });
  await new Promise((r) => setTimeout(r, 2500));
  await waitUntil(() => lines() > before, 15000).catch(() => {});
  let cur = lines(), last = -1;
  const dl = Date.now() + 8000;
  while (cur !== last && Date.now() < dl) { last = cur; await new Promise((r) => setTimeout(r, 300)); cur = lines(); }
  console.log("=== AFTER lines=", cur, "before=", before);
} finally {
  try { rmSync(ws, { recursive: true, force: true }); } catch {}
  try { rmSync(`${ws}-wt`, { recursive: true, force: true }); } catch {}
}
