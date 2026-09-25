// 仕事の発見器(blackboardへの自動投入)。
// ① テストプローブ: 定期実行し、失敗→fix-test-failuresタスク生成/復旧→自動解決。
//    ただしimpl等の通常タスクが残っている間はテスト失敗を仕事化しない(未マージ起因の偽失敗防止)。
// ② diffプローブ: `git diff reviewed main`(前回レビュー済み地点〜現main)に変化があれば
//    review-changesタスク生成。レビュー完了でreviewedタグをmainへ前進させる。
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
      void advanceReviewedTag(workspace, exec);
    }
  });

  // 通常タスク(impl等)が残っている間は、テスト失敗は未マージ起因の可能性が高い
  function hasOutstandingWork() {
    const s = tasks.snapshot();
    const ids = [
      ...s.open.map((f) => f.replace(/\.md$/, "")),
      ...s.claimed.map((f) => f.split("--").slice(1).join("--")),
    ];
    return ids.some((id) => !id.startsWith("fix-") && !id.startsWith("review-"));
  }

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
    if (hasOutstandingWork()) {
      bus.emit("discovery.skip", { reason: "通常タスクが残っているため、テスト失敗を仕事化しない" });
      return;
    }
    tasks.create({
      id: FIX_TASK_ID,
      body: `mainブランチでテストが失敗している。失敗出力を読み、原因を特定して修正し、テストを通せ。\n\n## 発見器が捉えた最新の失敗出力(末尾)\n\`\`\`\n${r.text.slice(-2500)}\n\`\`\`\n- 自分の作業ディレクトリで \`git merge main\` して最新を取り込んでから着手すること。\n- 修正後 \`${testCommand}\` を通し、ボードへ報告して finish_task。`,
    });
    bus.emit("discovery.created", { taskId: FIX_TASK_ID });
  }

  async function probeDiffs() {
    const d = await exec({ command: "git diff reviewed main --name-status", cwd: workspace, outputLimit: 4000 });
    if (!d.ok) return;
    const body = d.text.slice(d.text.indexOf("\n") + 1); // 先頭の exit=N を除く
    const lines = body.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) return;
    if (tasks.existsOpenOrClaimed(REVIEW_TASK_ID)) return;
    tasks.create({
      id: REVIEW_TASK_ID,
      role: "review",
      body: `mainに未レビューの変更がある。査読せよ。\n\n## 変更ファイル(git diff reviewed main --name-status)\n${lines.join("\n")}\n\n- まず bash で \`git merge main\` して最新mainを自分の作業ディレクトリへ取り込む。\n- 変更を読み、必要ならテストを実行して挙動を確認する。\n- 指摘は post_to_board へ(良い点も1つ)。致命的問題がなければ「問題なし」と明言。\n- 終わったら finish_task(完了時にレビュー済み地点が前進する)。`,
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

// ワークスペースをgitリポジトリとして初期化し、レビュー済み地点タグを用意する
export async function ensureGitRepo(workspace, exec = runCommand) {
  if (!existsSync(join(workspace, ".git"))) {
    await exec({ command: "git init -b main", cwd: workspace, outputLimit: 2000 });
    writeFileSync(join(workspace, ".gitignore"), "tasks/\ntmp/\nnode_modules/\n");
  }
  await exec({ command: "git add -A && (git diff --cached --quiet || git -c user.name=hive -c user.email=hive@local commit -m 'baseline')", cwd: workspace, outputLimit: 2000 });
  const tag = await exec({ command: "git rev-parse -q --verify reviewed", cwd: workspace, outputLimit: 500 });
  if (!tag.ok) {
    await exec({ command: "git tag reviewed", cwd: workspace, outputLimit: 500 });
  }
}

// レビュー完了: 迷い変更を確定してからレビュー済みタグをmainへ前進させる
export async function advanceReviewedTag(workspace, exec = runCommand) {
  await exec({ command: "git add -A && (git diff --cached --quiet || git -c user.name=hive -c user.email=hive@local commit -m 'checkpoint: stray changes before review tag')", cwd: workspace, outputLimit: 2000 });
  await exec({ command: "git tag -f reviewed main", cwd: workspace, outputLimit: 1000 });
}
