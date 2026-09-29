// respawn-chat.test.jsの失敗を再現する診断スクリプト
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChat } from "./src/runner.js";
import { Bus } from "./src/engine/board.js";
import { runCommand } from "./src/engine/exec.js";

const ws = mkdtempSync(join(tmpdir(), "hive-diag-respawn-"));
const root = `${ws}-wt`;
const config = {
  workspace: ws,
  worktrees: { dir: root },
  model: { contextWindow: 200000, maxTokens: 4000 },
  loop: { maxTurns: 10 },
  budget: null,
  compact: { thresholdPercent: 90 },
  discovery: {},
  permissions: {},
  scenario: { name: "test" },
  chat: { lead: "lead", workers: ["alpha", "beta", "gamma"], maxTurnsPerRound: 8, staggerMs: 5 },
  agents: [
    { id: "alpha", displayName: "アルファ", role: "impl" },
    { id: "beta", displayName: "ベータ", role: "review" },
    { id: "gamma", displayName: "ガンマ", role: "impl" },
  ],
};
const modelFactory = () => ({
  maxTokens: 4000,
  async chat() {
    return { content: "承知しました", toolCalls: [], raw: { content: "承知しました" }, usage: { promptTokens: 10, completionTokens: 1 } };
  },
});
try {
  const ctl1 = await runChat({ config, bus: new Bus(), modelFactory });
  await ctl1.openThread({ project: "crashy", goal: "中断されるスレッド" });
  const wtPath = join(root, "crashy-alpha");
  writeFileSync(join(wtPath, "half-done.txt"), "crashed work\n");
  const cm = await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m "wip-crash"`, cwd: wtPath, outputLimit: 500 });
  console.log("commit ok:", cm.ok, "| text:", cm.text.split("\n").slice(0,4).join(" / "));
  const bus2 = new Bus();
  const posts2 = [];
  bus2.on("board", (p) => posts2.push(p));
  await runChat({ config, bus: bus2, modelFactory });
  console.log("open dir:", readdirSync(join(ws, "tasks", "open")).join(", ") || "(empty)");
  const scanPosts = posts2.filter((p) => String(p.text ?? "").includes("起動時スキャン"));
  console.log("scan post exists:", scanPosts.length > 0);
  if (scanPosts.length) console.log(scanPosts[0].text);
  // main参照の確認: このテストwsはgitリポジトリか
  const g = await runCommand({ command: `git -C '${ws}' rev-parse --is-inside-work-tree`, outputLimit: 200 });
  console.log("ws is git repo:", g.ok, g.text.split("\n").slice(1).join(""));
} finally {
  try { rmSync(ws, { recursive: true, force: true }); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
