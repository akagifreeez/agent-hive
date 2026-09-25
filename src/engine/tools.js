// エージェントに渡すツール一式。ファイル系はワークスペース配下に閉じ込める
// (パス検証で workspace 外への脱出を拒否)。bashは cwd=ワークスペースで実行し、
// 承認制ゲート(gate)を通す。
import { statSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";
import { runCommand, detectShell } from "./exec.js";
import { mergeAgentWork } from "./worktree.js";
import { readMeta } from "./tasks.js";

const READ_LIMIT = 120 * 1024;
const BASH_OUTPUT_LIMIT = 8 * 1024;

export function createTools({ agent, workspace, mainWorkspace = null, board, tasks, bus, gate = null, spawner = null, maxBashMs = 30000, threadOpener = null }) {
  const specs = [
    {
      name: "claim_next_task",
      description: "タスクボードから自分が担当できる次のタスクを1件請求(claim)する。成功でタスク本文、無ければ『請求できるタスクはありません』が返る。projectを指定するとその文脈のタスクだけを対象にする(別の取り組みの仕事を混ぜない)。",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "文脈(プロジェクト)名。自分の担当する取り組みのタスクに絞るときに指定" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "finish_task",
      description: "自分が請求中のタスクを完了として確定する。task_idはclaim_next_taskの返値に示されたもの。",
      parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false },
    },
    {
      name: "create_task",
      description: "新しい仕事をタスクボードへ投入する。レビュー指摘の修正など後続の仕事を生んだときに使う。task_idは英小文字数字とハイフン。projectに文脈(取り組み名)を付けると、その取り組みのタスクとしてグルーピングされる。",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          role: { type: "string", description: "担当ロール(impl/review/lead等)。省略で誰でも可" },
          project: { type: "string", description: "文脈(プロジェクト)名。関連する取り組みに統一" },
          body: { type: "string", description: "具体的な指示(何を/どう確認するか/完了条件)" },
        },
        required: ["task_id", "body"],
        additionalProperties: false,
      },
    },
    {
      name: "spawn_agent",
      description: "作業用のサブエージェントを新規にスポーンする。briefに目標と完了条件を書く。ボード経過や完了タスクなどの共有素材は労働者側が gather_context で自分で読むので転写不要。スポーン後の追加指示はボード経由になる。",
      parameters: {
        type: "object",
        properties: {
          display_name: { type: "string", description: "短い表示名(例: pad実装係)" },
          role: { type: "string", description: "ロール(impl/review/lead等)" },
          project: { type: "string", description: "文脈(プロジェクト)名。労働者が追加のタスクを請求するときの絞込に使われる" },
          brief: { type: "string", description: "初期ブリーフ。目標・完了条件・このタスク固有の指示のみ。共有素材は労働者が gather_context で読む" },
        },
        required: ["brief"],
        additionalProperties: false,
      },
    },
    {
      name: "open_thread",
      description: "計画に基づきサブスレッドを開く(リーダー専用)。3エージェント(設計・実装/検証・レビュー/進行・調整)がそのスレッドで並行作業を始める。事前に create_task で project=<スレッド名> のタスクを起票しておくこと。",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "スレッド名(=プロジェクト名)。英小文字数字とハイフン" },
          goal: { type: "string", description: "スレッドの目標と受け入れ条件(1〜3文)" },
        },
        required: ["project", "goal"],
        additionalProperties: false,
      },
    },
    {
      name: "list_files",
      description: "ワークスペース内のファイル一覧を取得する。",
      parameters: { type: "object", properties: { path: { type: "string", description: "ワークスペース相対パス(省略時はルート)" } }, additionalProperties: false },
    },
    {
      name: "read_file",
      description: "ワークスペース内のファイルを読む。",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    },
    {
      name: "write_file",
      description: "ワークスペース内にファイルを新規作成または上書きする。",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    },
    {
      name: "edit_file",
      description: "既存ファイルの一部を置換する。old_textは一意に一致すること(複数箇所や不一致はエラー)。",
      parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"], additionalProperties: false },
    },
    {
      name: "bash",
      description: "ワークスペースを作業ディレクトリとしてシェルコマンドを実行する。作業の検証(テスト実行等)に使う。",
      parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "number", description: "省略時30000ms、最大120000ms" } }, required: ["command"], additionalProperties: false },
    },
    {
      name: "post_to_board",
      description: "共有ボードへ報告・指摘・質問を投稿する。他の全エージェントの目に留まる。",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    },
    {
      name: "wait_for_board",
      description: "他エージェントのボード投稿を待つ(最大180秒)。完了報告待ち等に使う。タイムアウト時はその旨が返る。",
      parameters: { type: "object", properties: { timeout_sec: { type: "number", description: "省略時60秒、最大180秒" } }, additionalProperties: false },
    },
    {
      name: "gather_context",
      description: "作業に必要な生素材を読む: source=\"board\"=ボードの全経過、\"done\"=完了タスクの本文、\"open\"=未着手タスクの本文。今のタスクに必要な前提を自分で集めるときに使う(読み取り時キュレーション)。projectで絞り込める。",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["board", "done", "open"] },
          limit: { type: "number", description: "最大件数(既定20)" },
          project: { type: "string", description: "文脈(プロジェクト)名で絞込(done/openのみ有効)" },
        },
        required: ["source"],
        additionalProperties: false,
      },
    },
  ];

  async function execute(name, args = {}) {
    try {
      return await dispatch(name, args);
    } catch (err) {
      return { ok: false, text: `ツールエラー: ${err.message}` };
    }
  }

  async function dispatch(name, args) {
    switch (name) {
      case "claim_next_task": {
        const opts = args.project ? { project: String(args.project) } : {};
        const t = tasks.claim(agent, opts);
        if (!t) {
          return {
            ok: true,
            claimMiss: true,
            text: args.project
              ? `請求できるタスクはありません(project: ${args.project} のタスクは無いか、全て完了済み)。`
              : "請求できるタスクはありません。",
          };
        }
        return { ok: true, text: `タスク ${t.id} を請求しました。\n\n${t.body}` };
      }
      case "finish_task": {
        const taskId = String(args.task_id ?? "");
        if (!tasks.claimedBy(agent.id).some((t) => t.id === taskId)) {
          return { ok: false, text: "そのタスクは請求していません(task_idを確認)。" };
        }
        // worktree運用時はmainへ自動マージしてから完了確定
        if (mainWorkspace) {
          const m = await mergeAgentWork({ mainWorkspace, worktreePath: workspace, agent, taskId });
          if (m.conflict) {
            bus.emit("merge.conflict", { agent: agent.id, taskId });
            return {
              ok: false,
              text: `マージが競合しました。あなたの作業ディレクトリで \`git merge main\` を実行し、競合ファイルを編集して解決 → \`git add -A && git commit\` → 再度 finish_task してください。\n\ngitの出力:\n${m.text.slice(0, 1500)}`,
            };
          }
          if (!m.ok) return { ok: false, text: `マージに失敗しました: ${m.text.slice(0, 500)}` };
          bus.emit("merge.completed", { agent: agent.id, taskId });
          board.post("system", `[マージ] ${agent.displayName}(${agent.id}) がタスク ${taskId} の成果を main へ取り込みました。`);
        }
        const done = tasks.finish(agent, taskId);
        if (!done) return { ok: false, text: "タスクの完了確定に失敗しました。" };
        return { ok: true, text: `タスク ${taskId} を完了にしました。` };
      }
      case "create_task": {
        const id = String(args.task_id ?? "").trim();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
          return { ok: false, text: "task_idは英小文字数字とハイフンで付けてください。" };
        }
        const created = tasks.create({ id, role: args.role ? String(args.role) : null, project: args.project ? String(args.project) : "", body: String(args.body ?? "") });
        if (!created) return { ok: false, text: `task_id ${id} は既に存在します。` };
        return { ok: true, text: `タスク ${id} をボードへ投入しました(role: ${args.role ?? "誰でも"}${args.project ? ` / project: ${args.project}` : ""})。` };
      }
      case "spawn_agent": {
        if (!spawner) return { ok: false, text: "このエージェントにはスポーン権限がありません。" };
        const r = await spawner.spawn({
          parent: agent,
          board, // 自分のスレッドのボードへスポーン関係の投稿を流す
          displayName: args.display_name ? String(args.display_name) : undefined,
          role: args.role ? String(args.role) : undefined,
          project: args.project ? String(args.project) : "",
          brief: String(args.brief ?? ""),
        });
        if (r.error) return { ok: false, text: `スポーンできません: ${r.error}` };
        return { ok: true, text: `サブエージェント ${r.id}(${r.displayName}) をスポーンしました。進捗はボードに流れます。` };
      }
      case "open_thread": {
        if (!threadOpener) return { ok: false, text: "open_threadはリーダー専用です。" };
        const project = String(args.project ?? "").trim();
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(project)) return { ok: false, text: "project(スレッド名)は英小文字数字とハイフンで40字以内にしてください。" };
        const goal = String(args.goal ?? "").trim();
        if (!goal) return { ok: false, text: "goalが空です。" };
        const tr = await threadOpener({ project, goal });
        if (tr.error) return { ok: false, text: `スレッドを開けません: ${tr.error}` };
        return { ok: true, text: `サブスレッド ${tr.id} を開きました。3エージェントが並行作業を始めました。` };
      }
      case "gather_context": {
        const source = String(args.source ?? "board");
        const limit = clamp(Number(args.limit ?? 20), 1, 100);
        const project = args.project ? String(args.project) : null;
        const GATHER_LIMIT = 12000;
        if (source === "board") {
          const posts = board.posts.slice(-limit);
          if (!posts.length) return { ok: true, text: "ボードに投稿はまだありません。" };
          const text = posts.map((p) => `[${p.from}] #${p.id}\n${p.text}`).join("\n---\n");
          return { ok: true, text: `ボード経過(${posts.length}件・末尾ほど新しい):\n${text.slice(-GATHER_LIMIT)}` };
        }
        const dir = join(mainWorkspace ?? workspace, "tasks", source === "done" ? "done" : "open");
        let files = [];
        try {
          files = readdirSync(dir).filter((f) => f.endsWith(".md")).filter((f) => !project || readMeta(join(dir, f)).project === project).sort();
        } catch {
          return { ok: true, text: "タスクボードは空です。" };
        }
        const picked = files.slice(-limit);
        const bodies = picked.map((f) => {
          let body = "";
          try {
            body = readFileSync(join(dir, f), "utf8").trim();
          } catch {
            // 読めないファイルは飛ばす
          }
          return `## ${f.replace(/\.md$/, "")}\n${body.slice(0, 2500)}`;
        });
        if (!picked.length) {
          return { ok: true, text: project ? `${source}タスクはありません(project: ${project})。` : `${source}タスクはありません。` };
        }
        return { ok: true, text: `${source === "done" ? "完了タスク" : "未着手タスク"}${project ? `(project: ${project})` : ""}(${picked.length}/${files.length}件):\n\n${bodies.join("\n\n")}`.slice(0, GATHER_LIMIT + 500) };
      }
      case "list_files": {
        const files = listWorkspaceFiles(safePath(args.path ?? "."));
        return { ok: true, text: files.length ? files.join("\n") : "(空)" };
      }
      case "read_file": {
        const p = safePath(args.path);
        const s = statSync(p, { throwIfNoEntry: false });
        if (!s || s.isDirectory()) return { ok: false, text: `ファイルが無いかディレクトリです: ${args.path}` };
        const buf = readFileSync(p);
        const clipped = buf.length > READ_LIMIT ? buf.subarray(0, READ_LIMIT).toString("utf8") + "\n...(以降省略)" : buf.toString("utf8");
        return { ok: true, text: clipped };
      }
      case "write_file": {
        const p = safePath(args.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(args.content ?? ""));
        return { ok: true, text: `${args.path} に書き込みました(${String(args.content ?? "").length}文字)。` };
      }
      case "edit_file": {
        const p = safePath(args.path);
        const src = readFileSync(p, "utf8");
        const oldText = String(args.old_text ?? "");
        const count = src.split(oldText).length - 1;
        if (count === 0) return { ok: false, text: "old_textが見つかりません。" };
        if (count > 1) return { ok: false, text: `old_textが${count}箇所に一致します。一意になるよう範囲を広げてください。` };
        writeFileSync(p, src.replace(oldText, String(args.new_text ?? "")));
        return { ok: true, text: `${args.path} を編集しました。` };
      }
      case "bash":
        return await gatedBash(String(args.command ?? ""), clamp(Number(args.timeout_ms) || maxBashMs, 1000, 120000));
      case "post_to_board": {
        const post = board.post(agent.id, String(args.text ?? ""));
        return { ok: true, text: `ボード#${post.id}へ投稿しました。` };
      }
      case "wait_for_board": {
        const sec = clamp(Number(args.timeout_sec) || 60, 5, 180);
        const got = await board.wait(agent.id, sec * 1000);
        return got
          ? { ok: true, text: `[${got.from}の投稿] ${got.text}` }
          : { ok: true, text: `${sec}秒で新着はありませんでした。` };
      }
      default:
        return { ok: false, text: `未知のツール: ${name}` };
    }
  }

  function safePath(p) {
    const root = resolve(workspace);
    const full = resolve(root, String(p ?? "."));
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`ワークスペース外のパスは扱えません: ${p}`);
    }
    return full;
  }

  // 承認制ゲート: 禁止パターンは即拒否、要承認パターンはUI承認を待つ
  async function gatedBash(command, timeoutMs) {
    if (gate) {
      const verdict = await gate.check(command);
      if (!verdict.allowed) {
        bus.emit("permission.denied", { agent: agent.id, command });
        return { ok: false, text: `このコマンドは拒否されました(${verdict.reason})。別の安全な方法で作業を続けてください。` };
      }
    }
    return await runCommand({ command, cwd: workspace, timeoutMs, outputLimit: BASH_OUTPUT_LIMIT });
  }

  return { specs, execute, detectShell };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ワークスペースのファイル一覧(UI共用)。node_modulesと隠しファイルは除外。
export function listWorkspaceFiles(dir) {
  const out = [];
  const walk = (d, prefix, depth) => {
    if (depth > 4 || out.length > 400) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      out.push(prefix + e.name + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) walk(join(d, e.name), prefix + e.name + "/", depth + 1);
    }
  };
  walk(dir, "", 0);
  return out;
}
