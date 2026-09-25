// 仕事の発見器(blackboardへの自動投入)。
// ① テストプローブ: 定期実行し、失敗→fix-test-failuresタスク生成/復旧→自動解決。
//    ただしimpl等の通常タスクが残っている間はテスト失敗を仕事化しない(未マージ起因の偽失敗防止)。
// ② diffプローブ: `git diff reviewed main`(前回レビュー済み地点〜現main)に変化があれば
//    review-changesタスク生成。レビュー完了でreviewedタグをmainへ前進させる。
// ③ 記憶プローブ: 未処理の完了タスクがあればdistill-learnings起票(idleなエージェントが
//    workspace/memory/ へ知見を抽出する)。完了時にエンジンが処理済みマーカーを進める。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./exec.js";

export const FIX_TASK_ID = "fix-test-failures";
export const REVIEW_TASK_ID = "review-changes";
export const DISTILL_TASK_ID = "distill-learnings";
const DISTILL_MARKER = "memory/.distilled"; // workspace起点。1行=処理済みのdoneタスクid

export function startDiscovery({ workspace, tasks, bus, intervalSec = 30, testCommand, exec = runCommand }) {
  let stopped = false;
  let busy = false;

  bus.on("task.finished", ({ taskId }) => {
    if (typeof taskId === "string" && taskId.startsWith("review-")) {
      void advanceReviewedTag(workspace, exec);
    }
    if (taskId === DISTILL_TASK_ID) {
      writeDistillMarker(workspace, tasks);
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

  async function probeMemory() {
    const done = tasks.snapshot().done.map((f) => f.replace(/\.md$/, "")).sort();
    const processed = new Set(readDistillMarker(workspace));
    const fresh = done.filter((id) => !processed.has(id));
    if (!tasks.existsOpenOrClaimed(DISTILL_TASK_ID)) {
      if (fresh.length === 0) return;
      if (hasOutstandingWork()) return; // 静かなときだけ起票(idleなエージェントの仕事にする)
      tasks.create({
        id: DISTILL_TASK_ID,
        body: `完了タスクとボードの経過から、再利用可能な知見を workspace/memory/ へ抽出せよ(永続記憶の保守)。

## 手順
- まず bash で \`git merge main\` して最新mainを取り込む。
- workspace/tasks/done/ の完了タスクと、その成果物(docs/やコードのコメント等)を読む。
- 次の種類の知見を workspace/memory/*.md へ反映する: 決定事項とその理由/制約(環境・依存・方式)/失敗と教訓/将来の作業への引き継ぎ事項。
- ファイルは目的別に分ける(例: decisions.md, constraints.md, lessons.md)。新規作成または既存への追記。重複は排除し、古くなった記述は削除でなく上書き訂正する。
- 個々の作業報告をそのまま写さない。「他のエージェントと将来のセッションが読む権威ファイル」として短く保つ。
- 反映したら post_to_board で要点を報告し、finish_task する(完了時に処理済み地点が前進する)。`,
      });
      bus.emit("discovery.created", { taskId: DISTILL_TASK_ID });
      return;
    }
    // 起票済みなのに未処理が消えていたら自動解決(テストプローブと同じ対称性)
    if (fresh.length === 0) {
      if (tasks.autoResolve(DISTILL_TASK_ID, "自動解決: 未処理の完了タスクが無い(発見器が確定)")) {
        bus.emit("discovery.resolved", { taskId: DISTILL_TASK_ID });
      }
    }
  }

  async function tick() {
    if (busy || stopped) return false;
    busy = true;
    try {
      await probeTests();
      await probeDiffs();
      await probeMemory();
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
  // distillマーカーはエンジン管理の簿記なのでgitに乗せない(テンプレートに無い時代の分も担保)
  const giPath = join(workspace, ".gitignore");
  if (existsSync(giPath)) {
    const gi = readFileSync(giPath, "utf8");
    if (!gi.includes(DISTILL_MARKER)) writeFileSync(giPath, gi.replace(/\s*$/, "") + "\n" + DISTILL_MARKER + "\n");
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

// distill-learningsの処理済みマーカー(エンジン管理。AIに書かせない)
function readDistillMarker(workspace) {
  try {
    return readFileSync(join(workspace, DISTILL_MARKER), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function writeDistillMarker(workspace, tasks) {
  const done = tasks.snapshot().done.map((f) => f.replace(/\.md$/, "")).sort();
  try {
    mkdirSync(join(workspace, "memory"), { recursive: true });
    writeFileSync(join(workspace, DISTILL_MARKER), done.join("\n") + "\n");
  } catch (err) {
    // マーカー書き失敗は次回の再起票で回収するので致命ではない
  }
}
