// 仕事の発見器(blackboardへの自動投入)。
// ① テストプローブ: 定期実行し、失敗→fix-test-failuresタスク生成/復旧→自動解決。
//    既定は軽量スモーク(単一テストファイル)を回す(フルスイートは検証タスク/設定明示時だけ。perf-probe)。
//    ただしimpl等の通常タスクが残っている間はテスト失敗を仕事化しない(未マージ起因の偽失敗防止)。
// ② diffプローブ: `git diff reviewed main`(前回レビュー済み地点〜現main)に変化があれば
//    review-changesタスク生成。レビュー完了でreviewedタグをmainへ前進させる。
// ③ 記憶プローブ: 未処理の完了タスクがあればdistill-learnings起票(idleなエージェントが
//    workspace/memory/ へ知見を抽出する)。完了時にエンジンが処理済みマーカーを進める。
// ④ READMEプローブ: コードからREADMEの自動セクション(readme-auto.js)を再生成し、
//    差分があればupdate-readmeタスク起票。マーカー外(人間の手書き部分)は構造的に触らない。
// ⑤ トリアージプローブ: フルスイートの失敗を既知/新規へ分類し、新規だけをfix候補へ(probes.triage)。
// ⑥ 教訓プローブ: 監査ログ(state/audit.jsonl)の失敗を時間窓で解析し、繰り返す同型失敗を
//    distill-lesson-<slug> タスクへ起票する(証跡付き)。distill-接頭辞は共通仕事なので誰でも請求でき、
//    検収を経てmainへマージされた教訓はmemory/経由で次ラウンドから全エージェントへ注入される。
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./exec.js";
import { parseTap, classifyFailures, buildFixCandidates, deriveArea } from "./test-triage.js";
import { detectStaleSections, genCliCommands, genRepoLayout, extractHelp } from "./readme-auto.js";
import { analyzeAuditFailures } from "./lessons.js";

export const FIX_TASK_ID = "fix-test-failures";
export const REVIEW_TASK_ID = "review-changes";
export const DISTILL_TASK_ID = "distill-learnings";
export const README_TASK_ID = "update-readme";
const DISTILL_MARKER = "memory/.distilled"; // workspace起点。1行=処理済みのdoneタスクid

// プローブ構成(discovery配下で上書き可)。既定は軽量スモーク: 高速な単一テストを
// intervalSec毎に回してmainの健在性だけを見張る。フルスイート(probes.tests="full")は
// 検証タスク(verify)や設定明示時だけ回す(マシン飽和対策: perf-probe-and-semaphore)。
const SMOKE_TEST_FILE = "test/exec.test.js"; // 高速(2秒前後)・依存ゼロの実テスト
/**
 * @param {Object} o
 * @param {string} o.workspace
 * @param {import("./tasks.js").TaskBlackboard} o.tasks
 * @param {import("./board.js").Bus} o.bus
 * @param {number} [o.intervalSec]
 * @param {string|null} [o.testCommand] テストプローブのコマンド(未指定なら既定スモーク)
 * @param {{tests?: "smoke"|"full"|"off", lessons?: {mode?: "on"|"off", minCount?: number, windowHours?: number}, triage?: {mode?: string, command?: string, timeoutMs?: number, knownFailures?: Array<{file: string, name: string, area: string}>}}} [o.probes] プローブ種別(discovery.probes)
 * @param {(o: any) => Promise<{ok: boolean, text: string}>} [o.exec]
 */
export function startDiscovery({ workspace, tasks, bus, intervalSec = 30, testCommand, probes = null, exec = runCommand }) {
  const mode = String(probes?.tests ?? (testCommand ? "custom" : "smoke")); // "smoke"|"full"|"custom"|"off"
  // smoke=軽量スモーク(既定) / full=旧挙動のフルスイート / custom=testCommand明示 / off=プローブ停止
  const command = testCommand ?? (mode === "smoke" ? `node --test ${SMOKE_TEST_FILE}` : mode === "full" ? "npm test" : null);
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
    if (mode === "off" || !command) return;
    const r = await exec({ command, cwd: workspace, timeoutMs: 120000, outputLimit: 3000 });
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
      body: `mainブランチでテストが失敗している。失敗出力を読み、原因を特定して修正し、テストを通せ。\n\n## 発見器が捉えた最新の失敗出力(末尾)\n\`\`\`\n${r.text.slice(-2500)}\n\`\`\`\n- 自分の作業ディレクトリで \`git merge main\` して最新を取り込んでから着手すること。\n- 修正後 \`${command}\` を通し、ボードへ報告して finish_task。`,
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

  async function probeReadme() {
    const path = join(workspace, "README.md");
    if (!existsSync(path)) return;
    if (tasks.existsOpenOrClaimed(README_TASK_ID)) return;
    const stale = detectStaleSections({
      repoRoot: workspace,
      generators: {
        "cli-commands": () => genCliCommandsFromRoot(workspace),
        "repo-layout": () => genRepoLayout(workspace),
      },
    });
    if (stale.length === 0) return;
    tasks.create({
      id: README_TASK_ID,
      acceptance: "READMEの自動セクション(`<!-- auto:... -->`間)だけが更新され、マーカー外の差分がgit diff README.mdに現れないこと。npm test全緑。",
      body: `コード変更をREADMEの自動セクションへ反映せよ(発見器が検知: 対象=${stale.join(", ")})。\n\n- まず bash で \`git merge main\` して最新mainを取り込む。\n- node で readme-auto.js を使ってREADMEを更新する: \`node --input-type=module -e "import { updateReadmeFromCode } from './src/engine/readme-auto.js'; console.log(updateReadmeFromCode({ repoRoot: process.cwd() }));"\`\n- 自動セクション(\`<!-- auto:... start/end -->\`間)だけが変わること。マーカー外の人間の文章は編集しない。\n- \`git diff README.md\` で差分を確認し、マーカー外に変化があれば中止してボードへ報告する。\n- 終わったらボードへ報告して finish_task。`,
    });
    bus.emit("discovery.created", { taskId: README_TASK_ID });
  }

  // ⑤ トリアージプローブ: フルスイート(または指定コマンド)を実行し、失敗を既知/新規へ分類。
  //    新規失敗だけをエリア別のfix候補タスクへ起票する(既知リストはconfig管理・TDD途中領域の区別)。
  //    重いフル実行は既定off(discovery.probes.triage.mode)。exec-test-semaphore着地後に有効化する想定。
  let triageBusy = false;
  async function probeTriage() {
    const t = probes?.triage;
    const mode = String(t?.mode ?? "off");
    if (mode === "off" || triageBusy) return;
    if (hasOutstandingWork()) {
      bus.emit("discovery.skip", { reason: "通常タスクが残っているため、重いトリアージ実行を飛ばす" });
      return;
    }
    triageBusy = true;
    try {
      const command = t.command ?? "npm test";
      // keep=tail: 失敗節(failing tests)は出力の末尾に出るため、末尾側を保持する
      const r = await exec({ command, cwd: workspace, timeoutMs: t.timeoutMs ?? 300000, outputLimit: 120000, keep: "tail" });
      const report = parseTap(r.text ?? "");
      const known = Array.isArray(t.knownFailures) ? t.knownFailures : [];
      if (r.ok && report.failures.length === 0) return; // 全緑: 仕事なし
      const cls = classifyFailures(report, known);
      const fresh = cls.fresh.filter((f) => !tasks.existsOpenOrClaimed("fix-triage-" + areaSlug(deriveAreaSafe(f))));
      const candidates = buildFixCandidates(fresh);
      for (const c of candidates) {
        if (tasks.existsOpenOrClaimed(c.id)) continue; // 重複起票防止
        tasks.create(c);
        bus.emit("discovery.created", { taskId: c.id });
      }
    } finally {
      triageBusy = false;
    }
  }
  // エリア名をタスクidに安全な形へ(小文字英数字とハイフン)
  function areaSlug(a) {
    return String(a ?? "unknown").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  }
  function deriveAreaSafe(f) {
    return deriveArea(f.file, f.name, f.errorType);
  }

  // bin/hive.jsのHELPを取り出してcli-commandsセクション本文を作るラッパ
  function genCliCommandsFromRoot(root) {
    const hivePath = join(root, "bin", "hive.js");
    if (!existsSync(hivePath)) return "";
    return genCliCommands(extractHelp(readFileSync(hivePath, "utf8")));
  }

  // ⑥ 教訓プローブ: 監査ログの同型失敗を教訓タスクへ(distill-lesson-<slug>)。
  //    証跡(件数+代表例)を本文に載せ、ワーカーが原因分析→memory/への教訓1条追記までを行う。
  //    教訓は検収マージを経てmemory/へ入るため、system promptへの自動注入は既存のmemoryFn経路で効く。
  let lessonsMtimeMs = -1; // 前回解析時のaudit.jsonl mtime(変化なしのティックは解析を飛ばす)
  async function probeLessons() {
    const cfg = probes?.lessons ?? {};
    if (String(cfg.mode ?? "on") === "off") return;
    const minCount = Math.max(2, Number(cfg.minCount ?? 5));
    const windowHours = Math.max(1, Number(cfg.windowHours ?? 24));
    const snap = tasks.snapshot();
    // 教訓タスクは1件ずつ(動いている間は次を出さない=起票の自己増殖を構造的に避ける)
    const inFlight = [...snap.open, ...snap.claimed].some((f) => f.includes("distill-lesson-"));
    if (inFlight) return;
    const file = join(workspace, "state", "audit.jsonl");
    if (!existsSync(file)) return;
    const mtime = statSync(file).mtimeMs;
    if (mtime === lessonsMtimeMs) return;
    lessonsMtimeMs = mtime;
    let entries = [];
    try {
      entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return;
    }
    const report = analyzeAuditFailures({ entries, windowMs: windowHours * 3600 * 1000, minCount });
    const top = report[0];
    if (!top) return;
    const id = `distill-lesson-${top.slug}`;
    // 同じ失敗パターンは1度だけ教訓化(done参照の恒久クールダウン。教訓の更新は
    // distill-learnings(③)の定期保守に任せる)
    if (snap.done.some((f) => f.endsWith(`--${id}.md`) || f === `${id}.md`)) return;
    tasks.create({
      id,
      acceptance: "memory/配下の教訓ファイルに症状/原因/ルール/証跡を1条として記録するか、既存ルールで済むことを根拠1行付きで報告すること",
      body: `監査ログ(state/audit.jsonl)で同型の失敗が繰り返されている。原因を分析し、再発防止の教訓を永続記憶へ反映せよ。

## 発見器が検出した失敗パターン(証跡)
- ツール: ${top.tool} / 直近${windowHours}時間で${top.count}件
- 代表例(教師文面の先頭):
${top.examples.map((x) => `  - ${x}`).join("\n")}

## 手順
- まず bash で \`git merge main\` して最新mainを取り込む。
- state/audit.jsonl から該当失敗(ok: false)を読み、共通の原因を特定する。
- 教訓は memory/lessons.md(無ければ新規作成)へ追記する。形式は短いルール1条: **症状 / 原因 / ルール(次に同じ場面で何をすべきか1文) / 証跡(件数+代表例)**。長い物語にしない(このファイルは全エージェントのシステムプロンプトへ注入される)。
- 原因が既存のルール(TEST_EXECUTION_RULESやmemory/constraints.md等)で既に扱われているなら、追記は不要。その根拠を1行ボードへ報告して finish_task してよい。
- ハーネス自体のコード修正が必要な規模の問題なら、修正はせずその旨をボードへ報告して完了してよい(コード変更は人間の判断を待つ)。
- 終わったら post_to_board で要点を報告し finish_task。`,
    });
    bus.emit("discovery.created", { taskId: id });
  }

  async function tick() {
    if (busy || stopped) return false;
    busy = true;
    try {
      await probeTests();
      await probeDiffs();
      await probeMemory();
      await probeReadme();
      await probeTriage();
      await probeLessons();
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
  // distillマーカーとチャットstate(ボードログ/会話メモリ)は簿記なのでgitに乗せない
  const giPath = join(workspace, ".gitignore");
  if (existsSync(giPath)) {
    let gi = readFileSync(giPath, "utf8");
    let dirty = false;
    for (const line of [DISTILL_MARKER, "state/"]) {
      if (!gi.includes(line)) {
        gi = gi.replace(/\s*$/, "") + "\n" + line + "\n";
        dirty = true;
      }
    }
    if (dirty) writeFileSync(giPath, gi);
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
