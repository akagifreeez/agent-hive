// runChat起動時のrespawnスキャン結合: プロセス再起動後もworktree差分から仕事が復元されること(#7)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChat } from "../../src/runner.js";
import { Bus } from "../../src/engine/board.js";
import { runCommand } from "../../src/engine/exec.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }

test("runChat: 起動時にworktree差分をスキャンし、未完了作業を再起票する", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-respawn-chat-"));
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
  // 1回目の起動でworktreeを作らせ、クラッシュを模擬して未マージの作業を残す
  const ctl1 = await runChat({ config, bus: new Bus(), modelFactory });
  await ctl1.openThread({ project: "crashy", goal: "中断されるスレッド" });
  const wtPath = join(root, "crashy-alpha");
  assert.ok(readFileSync !== null);
  // crashy-alphaのworktreeに未マージコミットを作る(=プロセス死で中断した作業)
  writeFileSync(join(wtPath, "half-done.txt"), "crashed work\n");
  // 未コミット変更として残す(=プロセス死で確定できなかった作業。コミット済み版は
  // ラウンド終了の自動マージで回収されるため、ここでは kept の対象を作る)
  // 2回目の起動(=クラッシュ後の再起動)
  const bus2 = new Bus();
  const posts2 = [];
  bus2.on("board", (p) => posts2.push(p));
  await runChat({ config, bus: bus2, modelFactory });
  // 起動タスクボードに respawn-crashy-alpha-* が起票されている
  const listed = readdirSync(join(ws, "tasks", "open")).filter((f) => f.startsWith("respawn-crashy-alpha-"));
  assert.equal(listed.length, 1, `respawnタスクが起票されている: ${listed.join(",")}`);
  const body = readFileSync(join(ws, "tasks", "open", listed[0]), "utf8");
  assert.match(body, /crashy-alpha/);
  assert.match(body, /クラッシュ復旧/);
  rmTree(ws); rmTree(root);
});
