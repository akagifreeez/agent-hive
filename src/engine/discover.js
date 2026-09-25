// 仕事の発見器(blackboardへの自動投入)。
// ① テストプローブ: 定期実行し、失敗→fix-test-failuresタスク生成/復旧→自動解決
// ② diffプローブ: git statusに変化があればreview-changesタスク生成。
//    レビュータスクの完了(finish_task)でチェックポイントコミットを打ち、次のdiffの起点をリセットする。
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./exec.js";

export const FIX_TASK_ID = "fix-test-failures";
export const REVIEW_TASK_ID = "review-changes";

export function startDiscovery({ workspace, tasks, bus, intervalSec = 30, testCommand, exec = runCommand }) {
  let stopped = false;
  let busy = false;

  bus.on("task.finished", ({ taskId }) => {
    if (typeof taskId === "string" && taskId.startsWith("review-")) {
      void commitCheckpoint(workspace, `checkpoint: 変更をレビュー済み(${new Date().toISOString()})`, exec);
    }
  });

  async function probeTests() {
    if (!testCommand) return;
    const r = await exec({ command: testCommand, cwd: workspace, timeoutMs: 120000, outputLimit: 3000 });
    if (r.ok) {
      if (tasks.autoResolve(FIX_TASK_ID, "自動解決: テストが通るようになった(発見器が確定)")) {
        bus.emit("discovery.resolved", { taskId: FIX_TASK_ID });
      }
      return;
    }
    if (tasks.existsOpenOrClaimed(FIX_TASK_ID)) return;
    tasks.create({
      id: FIX_TASK_ID,
      body: `テストが失敗している。失敗出力を読み、原因を特定して修正し、テストを通せ。\n\n## 発見器が捉えた最新の失敗出力(末尾)\n\`\`\`\n${r.text.slice(-2500)}\n\`\`\`\n修正したら \`${testCommand}\` を再実行して通ることを確認し、ボードへ報告して finish_task。`,
    });
    bus.emit("discovery.created", { taskId: FIX_TASK_ID });
  }

  async function probeDiffs() {
    const st = await exec({ command: "git status --porcelain", cwd: workspace, outputLimit: 4000 });
    if (!st.ok) return;
    const lines = st.text.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) return;
    if (tasks.existsOpenOrClaimed(REVIEW_TASK_ID)) return;
    tasks.create({
      id: REVIEW_TASK_ID,
      role: "review",
      body: `ワークスペースに未レビューの変更がある。git diff とファイルを読んで査読せよ。\n\n## 変更検出ファイル(git status)\n${lines.join("\n")}\n\n- 指摘は post_to_board へ(良い点も1つ)。致命的問題がなければ「問題なし」と明言。\n- 終わったら finish_task(完了時にチェックポイントコミットが打たれる)。`,
    });
    bus.emit("discovery.created", { taskId: REVIEW_TASK_ID });
  }

  async function tick() {
    if (busy || stopped) return false;
    busy = true;
    try {
      await probeTests();
      await probeDiffs();
      return true;
    } catch (err) {
      bus.emit("discovery.error", { error: err.message });
      return false;
    } finally {
      busy = false;
    }
  }

  const handle = setInterval(() => void tick(), Math.max(5, intervalSec) * 1000);
  if (handle.unref) handle.unref();

  return { tick, stop: () => { stopped = true; clearInterval(handle); } };
}

// ワークスペースをgitリポジトリとして初期化(既存なら何もしない)
export async function ensureGitRepo(workspace, exec = runCommand) {
  if (!existsSync(join(workspace, ".git"))) {
    await exec({ command: "git init -b main", cwd: workspace, outputLimit: 2000 });
    writeFileSync(join(workspace, ".gitignore"), "tasks/\ntmp/\nnode_modules/\n");
  }
  await exec({ command: "git add -A && (git diff --cached --quiet || git -c user.name=hive -c user.email=hive@local commit -m 'baseline')", cwd: workspace, outputLimit: 2000 });
}

export async function commitCheckpoint(workspace, message, exec = runCommand) {
  await exec({
    command: `git add -A && (git diff --cached --quiet || git -c user.name=hive -c user.email=hive@local commit -m '${message.replace(/'/g, "")}')`,
    cwd: workspace,
    outputLimit: 2000,
  });
}
