// エージェントに渡すツール一式。ファイル系はワークスペース配下に閉じ込める
// (パス検証で workspace 外への脱出を拒否)。bashは cwd=ワークスペースで実行し、
// 承認制ゲート(gate)を通す。
import { statSync, readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, renameSync, realpathSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";
import { runCommand, detectShell } from "./exec.js";
import { mergeAgentWork } from "./worktree.js";
import { readMeta, detectTaskOverlap } from "./tasks.js";
import { noteRejection } from "./model-policy.js";
import { readSkill } from "./skills.js";
import { browserFetch, browserExtract, browserSubmit } from "./browser.js";

const READ_LIMIT = 120 * 1024;
const BASH_OUTPUT_LIMIT = 8 * 1024;


// ツール実行結果の契約。全ツールはこの形を返し、loopの失敗連続打ち切り(idle退場)はokを数える。
// textはそのままLLMへの教師文面になる(何が失敗し、次の一手は何かを書く)。
/**
 * @typedef {Object} ToolResult
 * @property {boolean} ok
 * @property {string} text
 * @property {boolean} [claimMiss] 請求ミスのときtrue(idle退場判定で連続回数を数える)
 */

export function createTools({ agent, workspace, mainWorkspace = null, board, tasks, bus, gate = null, spawner = null, maxBashMs = 30000, threadOpener = null, threadCloser = null, mcpHosts = null, hooks = null, idleClaimWaitSec = 0, crossPoster = null, resolveBoard = null, approvals = null, modelPolicy = null }) {

  const mcpList = mcpHosts ?? [];
  const mcpSpecs = mcpList.flatMap((h) => h.specs());
  const specs = [
    {
      name: "claim_next_task",
      description: "タスクボードから自分が担当できる次のタスクを1件請求(claim)する。成功でタスク本文、無ければ『請求できるタスクはありません』が返る。projectを指定するとその文脈のタスクだけを対象にする(別の取り組みの仕事を混ぜない)。タスクが無いときはエンジン側で新着を待ってから返る(待ち時間はトークン消費ゼロ)。",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "文脈(プロジェクト)名。自分の担当する取り組みのタスクに絞るときに指定" },
          wait_sec: { type: "number", description: "タスクが無い場合に新着を待つ秒数(0で待たない。省略時は設定値、最大120)" },
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
      name: "approve_task",
      description: "検証したタスクを承認してmainへマージする。承認フロー(approvals)有効時、実装者以外のエージェントが検証後に実行する。自分が実装したタスクは承認できない。",
      parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false },
    },
    {
      name: "create_task",
      description: "新しい仕事をタスクボードへ投入する。レビュー指摘の修正など後続の仕事を生んだときに使う。task_idは英小文字数字とハイフン。projectに文脈(取り組み名)を付けると、その取り組みのタスクとしてグルーピングされる。acceptanceに受け入れ基準(何ができたら完了とみなすか)を1文で書くと、ワーカーの完成判定がブレなくなる。depends_onに先行タスクidの配列を付けると、それらが全部完了するまでこのタスクは請求不可になる。",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          role: { type: "string", description: "担当ロール(impl/review/lead等)。省略で誰でも可" },
          project: { type: "string", description: "文脈(プロジェクト)名。関連する取り組みに統一" },
          body: { type: "string", description: "具体的な指示(何を/どう確認するか/完了条件)" },
          acceptance: { type: "string", description: "受け入れ基準。完了とみなす客観的な条件を1文で(例: npm testが通り、境界の両側を検証している)" },
          depends_on: { type: "array", items: { type: "string" }, description: "先行タスクidの配列。全てdoneになるまでこのタスクは請求できない" },
          model: { type: "string", description: "[リーダー専用・任意] このタスクだけ代替モデルref(provider/modelまたはベアID)を使う。基本は既定モデルのまま(相当な理由があるときだけ)" },
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
          model: { type: "string", description: "この作業員のモデル指定(ModelRef)。リーダー専用・任意。未指定なら既定モデル" },
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
          folder: { type: "string", description: "ナビ表示用の分類(例: AI開発)。省略可" },
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
      description: "既存ファイルの一部を置換する。old_textは一意に一致すること(複数箇所や不一致はエラー)。replace_all: true で全一致を一括置換。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          replace_all: { type: "boolean", description: "全ての一致を一括置換するか" },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
    {
      name: "bash",
      description: "ワークスペースを作業ディレクトリとしてシェルコマンドを実行する。作業の検証(テスト実行等)に使う。",
      parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "number", description: "省略時30000ms、最大120000ms" } }, required: ["command"], additionalProperties: false },
    },
    {
      name: "post_to_board",

      description: "共有ボードへ報告・指摘・質問を投稿する。他の全エージェントの目に留まる。to_threadにスレッド名を指定するとそのスレッドのボードへ直接投稿する(自分のボードには載らない)。相手のメンバーを起こしたいときは本文に@表示名を含める。",
      parameters: { type: "object", properties: { text: { type: "string" }, to_thread: { type: "string", description: "投稿先スレッド名(省略時は自分のボード)" } }, required: ["text"], additionalProperties: false },

    },
    {
      name: "wait_for_board",
      description: "他エージェントのボード投稿を待つ(最大180秒)。完了報告待ち等に使う。タイムアウト時はその旨が返る。",
      parameters: { type: "object", properties: { timeout_sec: { type: "number", description: "省略時60秒、最大180秒" } }, additionalProperties: false },
    },
    {
      name: "gather_context",
      description: "作業に必要な生素材を読む: source=\"board\"=ボードの全経過、\"done\"=完了タスクの本文、\"open\"=未着手タスクの本文、\"threads\"=全スレッドの進捗サマリ。今のタスクに必要な前提を自分で集めるときに使う(読み取り時キュレーション)。projectで絞り込める。",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["board", "done", "open", "threads"] },
          limit: { type: "number", description: "最大件数(既定20)" },
          project: { type: "string", description: "文脈(プロジェクト)名で絞込(done/openのみ有効)" },
        },
        required: ["source"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_fetch",
      description: "内蔵ブラウザでURLを取得し、ページ構造(タイトル/見出し/リンク/フォーム/本文)を返す。絶対URL必須。レンダリング不要のHTTPレベル取得。",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "取得するURL(http://またはhttps://の絶対URL)" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_extract",
      description: "ページ取得(またはHTML直接)→セレクタ抽出を1呼び出しで行う。selectorはタグ名・#id・.classに対応(未指定は全文)。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "取得するURL(html指定時は省略可)" },
          html: { type: "string", description: "解析対象のHTML(指定時はurl取得を省略)" },
          base_url: { type: "string", description: "html指定時の基準URL" },
          selector: { type: "string", description: "抽出する要素(タグ名/#id/.class、省略で全文)" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_submit",
      description: "フォームを組立てて送信する(取得→入力→送信のHTTPレベル操作)。html+base_urlからフォーム抽出し、valuesで埋めてPOST/GET。selectorで送信対象要素を検証(誤送信防止)。レンダリング必須の実操作はMCP(Playwright等)で拡張。",
      parameters: {
        type: "object",
        properties: {
          html: { type: "string", description: "フォームを含むページHTML(browser_fetchのraw等)" },
          base_url: { type: "string", description: "そのページのURL(相対action解決の基準・絶対URL必須)" },
          values: { type: "object", description: "入力する値 {フィールド名: 値}。未指定フィールドは現値維持" },
          selector: { type: "string", description: "送信前に存在を検証する要素(タグ名またはフィールド名)。一致が無ければ送らない" },
          form_index: { type: "number", description: "複数フォーム時の対象(1始まり・省略で最初)" },
          follow_redirects: { type: "boolean", description: "リダイレクト追従(既定true)" },
        },
        required: ["html", "base_url"],
        additionalProperties: false,
      },
    },
    {
      name: "web_fetch",
      description: "指定URLの内容を取得する(http/https、GETのみ、テキスト)。調査の参照先やドキュメントを読むときに使う。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "取得するURL" },
          max_chars: { type: "number", description: "本文の最大文字数(既定8000)" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "web_search",
      description: "Web検索を行い、タイトルとURLの一覧を返す。本文を読むには web_fetch を併用する。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "検索語" },
          max_results: { type: "number", description: "最大件数(既定8)" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "search_files",
      description: "ワークスペース内を正規表現で全文検索し、file:行: 一致行を返す。glob(例: *.mjs)で対象ファイルを絞れる。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "正規表現" },
          glob: { type: "string", description: "対象ファイルのパターン(例: *.mjs、src/**/*.js)" },
          max_results: { type: "number", description: "最大一致数(既定50)" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    {
      name: "glob_files",
      description: "ワークスペース内のファイルを glob パターン(例: src/**/*.js、*.md)で一覧する。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "globパターン" },
          max_results: { type: "number", description: "最大件数(既定100)" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    ...mcpSpecs, // MCPサーバーが提供する外部ツール(mcp__<サーバー>__<ツール>)
    {
      name: "use_skill",
      description: "スキル(skills/配下のノウハウ文書)を読み込む。該当する作業があるときは着手前に読むこと。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "スキル名(システムプロンプトの索引にあるもの)" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "close_thread",
      description: "サブスレッドを閉じる(リーダー専用)。スレッド一覧から外れ、ワーカーは新規の起床を止める。成果物・タスク履歴・会話ログは消えない。",
      parameters: {
        type: "object",
        properties: { project: { type: "string", description: "閉じるスレッド名" } },
        required: ["project"],
        additionalProperties: false,
      },
    },
  ];

  async function execute(name, args = {}) {
    const t0 = Date.now();
    let out;
    let blocked = false;
    try {
      // beforeToolフック: 非ゼロ終了でツールをブロックできる(コードによる強制ルール)
      if (hooks?.has("beforeTool")) {
        const h = await hooks.run("beforeTool", { AGENT: agent.id, TOOL: name, ARGS: JSON.stringify(args ?? {}) });
        if (h.blocked) {
          blocked = true;
          out = { ok: false, text: `ツール ${name} はhooksによりブロックされました:\n${h.text}` };
          return out;
        }
      }
      // MCPツール(mcp__<サーバー>__<ツール>)は対応ホストへ委譲
      if (name.startsWith("mcp__")) {
        const host = mcpList.find((h) => h.handles(name));
        if (!host) {
          out = { ok: false, text: `このMCPツールは接続されていません: ${name}` };
          return out;
        }
        out = await host.call(name, args);
      } else {
        out = await dispatch(name, args);
      }
      if (hooks?.has("afterTool")) {
        await hooks.run("afterTool", { AGENT: agent.id, TOOL: name, OK: out.ok ? "1" : "0", BRIEF: out.text.slice(0, 200) });
      }
      return out;
    } catch (err) {
      out = { ok: false, text: `ツールエラー: ${err.message}` };
      return out;
    } finally {
      // 監査台帳(state/audit.jsonl): 全ツール実行を1行JSONで記録する。
      // PC操作制限の「事後検証」用で、拒否・ブロックも含めて残す(エラーでも記録を止めない)
      writeAudit(name, args, out ?? { ok: false, text: "(応答なし)" }, Date.now() - t0, blocked);
    }
  }

  // state/audit.jsonl への追記。巨大化したら世代交代(audit-1.jsonlへ退避)して1ファイルを小さく保つ
  function writeAudit(tool, args, out, ms, blocked) {
    try {
      const dir = join(mainWorkspace ?? workspace, "state");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "audit.jsonl");
      const entry = {
        ts: new Date().toISOString(),
        agent: agent.id,
        tool,
        ok: out.ok === true,
        ms,
        ...(blocked ? { blocked: true } : {}),
        ...(tool === "bash" ? { cmd: String(args.command ?? "").slice(0, 200) } : {}),
        ...(args?.path ? { path: String(args.path).slice(0, 200) } : {}),
        brief: String(out.text ?? "").replace(/\s+/g, " ").slice(0, 150),
      };
      appendFileSync(file, JSON.stringify(entry) + "\n");
      // 5MB超で1世代ローテート(監査は失わないが最新世代を軽く保つ)
      if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) {
        renameSync(file, join(dir, "audit-1.jsonl"));
      }
    } catch {
      // 簿記の失敗でエージェントの作業を止めない
    }
  }

  async function dispatch(name, args) {
    switch (name) {
      case "claim_next_task": {
        const opts = args.project ? { project: String(args.project) } : {};
        // 待ち行: 新規タスクの出現をエンジン側で待つ(LLMを起こさないので待ち時間のトークン消費はゼロ)
        const waitSec = clamp(Math.floor(Number(args.wait_sec ?? idleClaimWaitSec) || 0), 0, 120);
        const deadline = waitSec > 0 ? Date.now() + waitSec * 1000 : 0;
        let t = tasks.claim(agent, opts);
        while (!t && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          t = tasks.claim(agent, opts);
        }
        if (!t) {
          // 診断: project一致の未着手タスクがあるのに請求できない=role不一致が濃厚。
          // 「無い」としか返さないと実在するタスクを見失って空待ち・退場になる(r7で実際に発生)
          let hint = "";
          try {
            const allOpen = tasks.list().open;
            // 依存でブロック中のタスクは「実在するが依存未完了で請求不可」なので分けて教える(空待ち防止)
            const blockedTasks = allOpen.filter((x) => Array.isArray(x.dependsOn) && x.dependsOn.length);
            const depInfo = blockedTasks.length
              ? blockedTasks.map((x) => {
                  const parts = x.dependsOn.map((d) => `${d}(${tasks.isUnresolved(d) ? "未完了" : "完了済"})`);
                  return `${x.id} ← ${parts.join(",")}`;
                }).join(", ")
              : "";
            if (args.project) {
              const open = allOpen.filter((x) => (x.project || "") === String(args.project));
              if (open.length) {
                hint = `\n[診断] project「${args.project}」の未着手タスクが${open.length}件あります: ${open.map((x) => `${x.id}${x.role ? `(role:${x.role})` : ""}`).join(", ")}。あなたのロールは${agent.role}です。roleが一致するタスクか、role指定の無いタスクだけを請求できます。`;
              }
            } else if (allOpen.length) {
              // project無し(メインチャット)でも実在タスクを見失わせない。role不一致の空待ち・退場を防ぐ
              const items = allOpen.map((x) => `${x.id}${x.role ? `(role:${x.role})` : ""}${x.project ? `/project:${x.project}` : ""}`);
              hint = `\n[診断] 未着手タスクが${allOpen.length}件あります: ${items.join(", ")}。あなたのロールは${agent.role}です。roleが一致するタスクか、role指定の無いタスクだけを請求できます。`;
            }
            if (depInfo) hint += `\n[診断] 依存でブロック中: ${depInfo}。依存タスクの完了を待つか、自分で依存タスクを請求して先に消化してください。`;
          } catch {}
          return {
            ok: true,
            claimMiss: true,
            text: args.project
              ? `請求できるタスクはありません(project: ${args.project} のタスクは無いか、全て完了済み)。${hint}`
              : `請求できるタスクはありません。${hint}`,
          };
        }
        // 受け入れ基準(acceptance:メタ行)があれば先頭で目立たせる(完成判定のブレ防止)
        const acc = t.body.match(/^acceptance:\s*(.+)$/m);
        return { ok: true, text: `タスク ${t.id} を請求しました。${acc ? `\n受け入れ基準: ${acc[1].trim()}` : ""}\n\n${t.body}` };
      }
      case "finish_task": {
        const taskId = String(args.task_id ?? "");
        if (!tasks.claimedBy(agent.id).some((t) => t.id === taskId)) {
          return { ok: false, text: "そのタスクは請求していません(task_idを確認)。" };
        }
        // 検証タスク(verify-*)の完了: これ以上の検証タスクを起票しない(無限連鎖防止)。
        // 元タスクが保留中なら実装者≠検証者を確認してマージ+完了確定する。
        if (mainWorkspace && taskId.startsWith("verify-")) {
          const originalId = taskId.replace(/^verify-/, "");
          const pending = approvals?.pending.get(originalId) ?? null;
          if (pending && pending.agentId === agent.id) {
            return { ok: false, text: `自分が実装したタスク ${originalId} の検証は、実装者以外が行う必要があります(検証タスクは保留のまま残ります)。` };
          }
          const verifyDone = tasks.finish(agent, taskId);
          if (!pending) {
            return { ok: true, text: verifyDone ? `検証タスク ${taskId} を完了にしました(元タスクの保留情報が無いためマージは行いません)。` : "完了確定に失敗しました。" };
          }
          const implementer = { id: pending.agentId, displayName: pending.agentId };
          const m = await mergeAgentWork({ mainWorkspace, worktreePath: pending.worktreePath, agent: implementer, taskId: originalId });
          if (m.conflict) {
            const rej = noteRejection(mainWorkspace, originalId, modelPolicy);
            if (rej.notice) board.post("system", rej.notice);
            return { ok: false, text: `マージが競合しています。実装者(${pending.agentId})に \`git merge main\` での解決を依頼してください。\n${m.text.slice(0, 600)}` };
          }
          if (!m.ok) return { ok: false, text: `マージに失敗しました: ${m.text.slice(0, 500)}` };
          approvals.pending.delete(originalId);
          const implDone = tasks.finish({ id: pending.agentId }, originalId);
          bus.emit("merge.completed", { agent: pending.agentId, taskId: originalId, stat: m.stat ?? "", patch: m.patch ?? "", summary: m.summary ?? "" });
          board.post("system", `[承認] ${agent.displayName}(${agent.id}) がタスク ${originalId}(${pending.agentId}実装)を検証し、main へマージしました。`);
          return { ok: true, text: implDone
            ? `検証完了。タスク ${originalId} を承認してマージしました。`
            : `検証完了。タスク ${originalId} をマージしました(元タスクの完了確定は既に済みの可能性があります)。` };
        }
        // worktree運用時はmainへ自動マージしてから完了確定
        if (mainWorkspace) {
          // 実装者≠検証者の強制(approvals.require): マージを保留し、実装者以外の検証タスクを起票する。
          // 元タスクはclaimedのまま保留(approve_taskで承認された時点でマージ+完了確定)
          if (approvals?.require) {
            const reviewer = approvals.pickReviewer(agent.id);
            const verifyId = `verify-${taskId}`;
            if (reviewer && reviewer.id !== agent.id) {
              const claimedTask = tasks.claimedBy(agent.id).find((t) => t.id === taskId);
              const created = tasks.create({
                id: verifyId,
                role: reviewer.role,
                project: claimedTask?.project ?? "",
                body: `検証: タスク ${taskId}(${agent.id} 実装)の差分をレビューしてください。\n動作確認(テスト実行など)を行い、問題なければ finish_task (task_id: "${verifyId}") で検証完了としてください。承認後、成果が main へマージされます。`,
                createdBy: agent.id,
              });
              approvals.pending.set(taskId, { agentId: agent.id, worktreePath: workspace });
              return { ok: true, text: created
                ? `検証タスク ${verifyId}(${reviewer.id} 担当)を起票しました。承認後、成果が main へマージされます。`
                : `検証タスク ${verifyId} は既に起票済みです(承認待ち)。` };
            }
            // 実装者以外が設定にいない場合は承認不可として通常フローへ
          }
          const m = await mergeAgentWork({ mainWorkspace, worktreePath: workspace, agent, taskId });
          if (m.conflict) {
            bus.emit("merge.conflict", { agent: agent.id, taskId });
            return {
              ok: false,
              text: `マージが競合しました。あなたの作業ディレクトリで \`git merge main\` を実行し、競合ファイルを編集して解決 → \`git add -A && git commit\` → 再度 finish_task してください。\n\ngitの出力:\n${m.text.slice(0, 1500)}`,
            };
          }
          if (!m.ok) return { ok: false, text: `マージに失敗しました: ${m.text.slice(0, 500)}` };
          bus.emit("merge.completed", { agent: agent.id, taskId, stat: m.stat ?? "", patch: m.patch ?? "", summary: m.summary ?? "" });
          board.post("system", `[マージ] ${agent.displayName}(${agent.id}) がタスク ${taskId} の成果を main へ取り込みました${m.summary ? `(${m.summary})` : ""}。`);
        }
        const done = tasks.finish(agent, taskId);
        if (!done) return { ok: false, text: "タスクの完了確定に失敗しました。" };
        return { ok: true, text: `タスク ${taskId} を完了にしました。` };
      }
      case "approve_task": {
        // 実装者≠検証者の強制の承認側。検証者が実行すると保留タスクをmainへマージし完了確定する
        if (!approvals) return { ok: false, text: "この環境では承認フローは有効ではありません。" };
        const approveId = String(args.task_id ?? "");
        const pending = approvals.pending.get(approveId);
        if (!pending) {
          const ids = [...approvals.pending.keys()].join(", ") || "なし";
          return { ok: false, text: `承認待ちのタスクがありません(承認待ち: ${ids})。task_idを確認してください。` };
        }
        if (pending.agentId === agent.id) {
          return { ok: false, text: "自分が実装したタスクは自分で承認できません(実装者≠検証者の強制)。" };
        }
        const implementer = { id: pending.agentId, displayName: pending.agentId };
        const m = await mergeAgentWork({ mainWorkspace, worktreePath: pending.worktreePath, agent: implementer, taskId: approveId });
        if (m.conflict) {
          const rej = noteRejection(mainWorkspace, approveId, modelPolicy);
          if (rej.notice) board.post("system", rej.notice);
          return { ok: false, text: `マージが競合しています。実装者(${pending.agentId})に \`git merge main\` での解決を依頼してください。\n${m.text.slice(0, 600)}` };
        }
        if (!m.ok) return { ok: false, text: `マージに失敗しました: ${m.text.slice(0, 500)}` };
        approvals.pending.delete(approveId);
        const doneOk = tasks.finish({ id: pending.agentId }, approveId);
        bus.emit("merge.completed", { agent: pending.agentId, taskId: approveId, stat: m.stat ?? "", patch: m.patch ?? "", summary: m.summary ?? "" });
        board.post("system", `[承認] ${agent.displayName}(${agent.id}) がタスク ${approveId}(${pending.agentId}実装)を検証し、main へマージしました。`);
        return { ok: true, text: doneOk
          ? `タスク ${approveId} を承認してマージしました。`
          : `タスク ${approveId} をマージしました(完了確定に失敗: 実装者ファイルの状態を確認)` };
      }
      case "create_task": {
        const id = String(args.task_id ?? "").trim();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
          return { ok: false, text: "task_idは英小文字数字とハイフンで付けてください。" };
        }
        const dependsOn = Array.isArray(args.depends_on) ? args.depends_on.map((s) => String(s ?? "").trim()).filter(Boolean) : [];
        // 依存タスクがopenのままなら起票を拒否(fail-fast。依存が全doneになるまで請求不可なのに起票すると永遠に請求できない幽霊タスクになる。イシュー#25)
        if (dependsOn.length) {
          const openDeps = tasks.list().open.filter((t) => dependsOn.includes(t.id));
          if (openDeps.length > 0) return { ok: false, text: `依存タスクが未完了のため起票できません: ${openDeps.map((t) => t.id).join(", ")}。完了を待つか、depends_onを外して再起票してください。` };
        }
        // 代替モデル指定(#12): 基本は既定モデル。リーダー(スレッド開設権持ち)だけ特例で指定可
        const modelArg = String(args.model ?? "").trim() || null;
        if (modelArg && !threadOpener) {
          return { ok: false, text: "model指定はリーダー専用です(基本は既定モデルを使います。代替は相当な理由があるときだけ)。" };
        }
        const created = tasks.create({ id, role: args.role ? String(args.role) : null, project: args.project ? String(args.project) : "", body: String(args.body ?? ""), acceptance: args.acceptance ? String(args.acceptance) : "", dependsOn, createdBy: agent.id, model: modelArg });
        if (!created) return { ok: false, text: `task_id ${id} は既に存在します。` };
        // 重複検知: 未着手/作業中の既存タスクと共有ファイルがあれば警告を添える(ブロックはしない)
        const l = tasks.list();
                // list()の返値はUI向けサマリ(bodyなし)なので、重複検知にはファイル本文を読んで渡す
        const existing = [...l.open, ...l.claimed].map((t) => {
          const rel = String(t.path ?? "").split("/").join("/");
          const file = rel.startsWith("tasks/") ? join(tasks.dir, rel.slice("tasks/".length)) : null;
          const body = file && existsSync(file) ? readFileSync(file, "utf8") : "";
          return { id: t.id, body };
        });
        const overlaps = detectTaskOverlap(String(args.body ?? ""), existing.filter((t) => t.id !== id));
        const warn = (overlaps ?? [])
          .map((o) => `警告: 既存タスク ${o.taskId} が同じファイル(${o.files.join(", ")})を扱っています。重複の可能性。中止ならtasks cancel ${o.taskId}`)
          .join("\n");
        return {
          ok: true,
          text: `タスク ${id} をボードへ投入しました(role: ${args.role ?? "誰でも"}${args.project ? ` / project: ${args.project}` : ""}${args.acceptance ? " / 受け入れ基準つき" : ""}${dependsOn.length ? ` / 依存: ${dependsOn.join(",")}` : ""}${modelArg ? ` / model: ${modelArg}` : ""})。` + (warn ? "\n\n" + warn : ""),
        };
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
          model: String(args.model ?? "").trim() || null,
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
        const tr = await threadOpener({ project, goal, folder: args.folder ? String(args.folder).trim() : null });
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
        if (source === "threads") {
          // 全スレッドの進捗サマリ(リーダーが進捗を確認する用)。ログはstate/の永続ファイルから読む
          const dir = join(mainWorkspace ?? workspace, "state");
          let registry = [];
          try {
            registry = JSON.parse(readFileSync(join(dir, "threads.json"), "utf8"));
          } catch {}
          const names = registry.filter((t) => t.name !== "__main__").map((t) => t.name);
          if (!names.length) return { ok: true, text: "開いているスレッドはありません。" };
          const l = tasks.list();
          const lines = names.map((name) => {
            const th = registry.find((t) => t.name === name);
            const openN = l.open.filter((t) => (t.project || "") === name).length;
            const claimedN = l.claimed.filter((t) => (t.project || "") === name).length;
            const doneN = l.done.filter((t) => (t.project || "") === name).length;
            let tail = ["(投稿なし)"];
            try {
              tail = readFileSync(join(dir, `board-${name}.jsonl`), "utf8").trim().split("\n").filter(Boolean).slice(-3)
                .map((line) => {
                  try {
                    const p = JSON.parse(line);
                    return `[${p.from}] ${String(p.text).replace(/\s+/g, " ").slice(0, 140)}`;
                  } catch {
                    return "";
                  }
                })
                .filter(Boolean);
              if (!tail.length) tail = ["(投稿なし)"];
            } catch {}
            return `## スレッド ${name}\n目標: ${th?.goal ?? "(未記録)"}\nタスク: 未着手${openN} / 作業中${claimedN} / 完了${doneN}\n最近の投稿:\n${tail.map((s) => "- " + s).join("\n")}`;
          });
          return { ok: true, text: `スレッド進捗サマリ:\n\n${lines.join("\n\n")}`.slice(0, GATHER_LIMIT) };
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
      case "close_thread": {
        if (!threadCloser) return { ok: false, text: "close_threadはリーダー専用です。" };
        const projectName = String(args.project ?? "").trim();
        const r = await threadCloser({ project: projectName });
        if (r.error) return { ok: false, text: `スレッドを閉じられません: ${r.error}` };
        return { ok: true, text: `スレッド ${projectName} を閉じました。成果物とログは保持されています。` };
      }
      case "browser_fetch": {
        const r = await browserFetch(String(args.url ?? ""));
        if (!r.ok) return { ok: false, text: r.text };
        const lines = [];
        lines.push("[" + r.status + "] " + r.page.url);
        lines.push("タイトル: " + (r.page.title || "(なし)"));
        lines.push("");
        lines.push("見出し: " + (r.page.headings.join(" / ") || "(なし)"));
        lines.push("");
        lines.push("リンク:");
        for (const l of r.page.links.slice(0, 20)) lines.push("- " + l.text + " → " + l.href);
        lines.push("");
        lines.push("フォーム " + r.page.forms.length + "件:");
        for (const f of r.page.forms) lines.push("- [" + f.index + "] " + f.method + " " + f.action + " (" + f.fields.length + "fields)");
        lines.push("");
        lines.push("=== 本文 ===");
        lines.push(r.page.text);
        return { ok: true, text: lines.join("\n").slice(0, 8000) };
      }
      case "browser_extract": {
        const er = await browserExtract(args);
        if (!er.ok) return { ok: false, text: er.text };
        return { ok: true, text: ("[" + er.url + "]" + "\n" + "selector: " + (er.selector || "(全文)") + "\n" + er.text).slice(0, 8000) };
      }
      case "browser_submit": {
        const values = args.values && typeof args.values === "object" ? args.values : {};
        const sr = await browserSubmit({ html: args.html, base_url: args.base_url, values, selector: args.selector, form_index: args.form_index, follow_redirects: args.follow_redirects });
        return { ok: sr.ok, text: sr.text.slice(0, 8000) };
      }
      case "web_fetch": {
        const url = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return { ok: false, text: "urlはhttp(s)で始めてください。" };
        const maxChars = clamp(Number(args.max_chars ?? 8000), 200, 50000);
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "user-agent": "agent-hive/1.0" }, redirect: "follow" });
          const ct = res.headers?.get?.("content-type") ?? "(不明)";
          const text = await res.text();
          if (!res.ok) return { ok: false, text: `HTTP ${res.status}: ${text.slice(0, 300)}` };
          return { ok: true, text: `[${res.status}] ${url}\ncontent-type: ${ct}\n\n${text.slice(0, maxChars)}` };
        } catch (err) {
          return { ok: false, text: `取得エラー: ${err.message}` };
        }
      }
      case "use_skill": {
        const text = readSkill(workspace, String(args.name ?? ""));
        if (!text) return { ok: false, text: `スキルが見つかりません: ${args.name}(索引にある名前を指定してください)` };
        return { ok: true, text };
      }
      case "web_search": {
        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, text: "queryが空です。" };
        const maxN = clamp(Number(args.max_results ?? 8), 1, 20);
        // 既定はDuckDuckGo(HTML)。HIVE_SEARCH_URLで {query} 入りのテンプレートに差し替え可
        const template = process.env.HIVE_SEARCH_URL || "https://html.duckduckgo.com/html/?q={query}";
        const url = template.replace("{query}", encodeURIComponent(query));
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "user-agent": "agent-hive/1.0" }, redirect: "follow" });
          const html = await res.text();
          if (!res.ok) return { ok: false, text: `HTTP ${res.status}: ${html.slice(0, 300)}` };
          const results = [];
          const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
          let m;
          while ((m = re.exec(html)) && results.length < maxN) {
            let href = m[1];
            const uddg = href.match(/[?&]uddg=([^&]+)/);
            if (uddg) {
              try { href = decodeURIComponent(uddg[1]); } catch {}
            }
            const title = decodeEntities(m[2].replace(/<[^>]*>/g, "")).trim();
            if (title && /^https?:\/\//.test(href)) results.push(`[${results.length + 1}] ${title}\n    ${href}`);
          }
          if (!results.length) return { ok: true, text: `検索結果が取得できませんでした(${query})。語を変えるか web_fetch を試してください。` };
          return { ok: true, text: `検索: ${query}(${results.length}件)\n\n${results.join("\n")}` };
        } catch (err) {
          return { ok: false, text: `検索エラー: ${err.message}` };
        }
      }
      case "search_files": {
        const pattern = String(args.pattern ?? "");
        let re;
        try {
          re = new RegExp(pattern, "i");
        } catch (err) {
          return { ok: false, text: `patternが不正です: ${err.message}` };
        }
        const maxN = clamp(Number(args.max_results ?? 50), 1, 500);
        const rels = listWorkspaceFiles(workspace);
        const gRe = args.glob ? globToRegex(String(args.glob)) : null;
        const out = [];
        for (const rel of rels) {
          if (out.length >= maxN) break;
          if (gRe && !gRe.test(rel)) continue;
          const file = join(workspace, rel);
          let src;
          try {
            if (statSync(file, { throwIfNoEntry: false })?.size > 512 * 1024) continue;
            src = readFileSync(file, "utf8");
          } catch {
            continue;
          }
          const lines = src.split("\n");
          for (let i = 0; i < lines.length && out.length < maxN; i++) {
            if (re.test(lines[i])) out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
        if (!out.length) return { ok: true, text: `一致なし(${pattern})` };
        return { ok: true, text: `${out.length}件一致:\n${out.join("\n")}` };
      }
      case "glob_files": {
        const gRe = globToRegex(String(args.pattern ?? "*"));
        const maxN = clamp(Number(args.max_results ?? 100), 1, 500);
        const files = listWorkspaceFiles(workspace).filter((f) => gRe.test(f)).slice(0, maxN);
        if (!files.length) return { ok: true, text: `一致するファイルはありません(${args.pattern})` };
        return { ok: true, text: files.join("\n") };
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
        const p = safeWritePath(args.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(args.content ?? ""));
        return { ok: true, text: `${args.path} に書き込みました(${String(args.content ?? "").length}文字)。` };
      }
      case "edit_file": {
        const p = safeWritePath(args.path);
        const src = readFileSync(p, "utf8");
        const oldText = String(args.old_text ?? "");
        const count = src.split(oldText).length - 1;
        if (count === 0) return { ok: false, text: "old_textが見つかりません。" };
        if (args.replace_all) {
          writeFileSync(p, src.split(oldText).join(String(args.new_text ?? "")));
          return { ok: true, text: `${args.path} の${count}箇所を一括置換しました。` };
        }
        if (count > 1) return { ok: false, text: `old_textが${count}箇所に一致します。一意になるよう範囲を広げるか replace_all を使ってください。` };
        writeFileSync(p, src.replace(oldText, String(args.new_text ?? "")));
        return { ok: true, text: `${args.path} を編集しました。` };
      }
      case "bash":
        return await gatedBash(String(args.command ?? ""), clamp(Number(args.timeout_ms) || maxBashMs, 1000, 120000));
      case "post_to_board": {

        const dest = String(args.to_thread ?? "").trim();
        if (dest) {
          // crosstalk: 指定スレッドのボードへ直接投稿(自分のボードには載せない)。不在ならエラー
          if (crossPoster) {
            const r = crossPoster(dest, agent.id, String(args.text ?? ""));
            if (!r.ok) return { ok: false, text: r.error ?? "投稿できませんでした" };
            return { ok: true, text: `スレッド ${dest} のボード#${r.id}へ投稿しました。` };
          }
          // resolveBoard方式(design-to-thread.md): 宛先Boardを解決して直接投稿
          if (resolveBoard) {
            const destBoard = resolveBoard(dest);
            if (!destBoard) return { ok: false, text: `宛先スレッドが存在しません: ${dest}` };
            const post = destBoard.post(agent.id, String(args.text ?? ""));
            return { ok: true, text: `ボード#${post.id}(${dest})へ投稿しました。` };
          }
          return { ok: false, text: "このスレッドからは他スレッドへ投稿できません" };
        }
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

  // state/ はエンジン内部データ(ボードJSONL・threads等)の領域。エージェントの書き込み系ツールからは禁止
  function assertNotState(full, p) {
    const stateRoot = resolve(workspace, "state") + sep;
    const cmp = process.platform === "win32" ? (x) => x.toLowerCase() : (x) => x;
    if (cmp(full) === cmp(resolve(workspace, "state")) || cmp(full).startsWith(cmp(stateRoot))) {
      throw new Error(`state/ 配下はエンジン管理領域のため書き込めません: ${p}`);
    }
  }

  function safePath(p) {
    const root = resolve(workspace);
    const full = resolve(root, String(p ?? "."));
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`ワークスペース外のパスは扱えません: ${p}`);
    }
    // symlink経由の脱出を拒否: 実体(realpath)がワークスペース内に収まっていること。
    // 存在しないパスは作成前提なので、最も近い存在する親を辿って検証する
    let probe = full;
    for (;;) {
      try {
        const real = realpathSync(probe);
        if (real !== root && !real.startsWith(root + sep)) {
          throw new Error(`ワークスペース外を指すsymlink/パスは扱えません: ${p}`);
        }
        break;
      } catch (err) {
        if (err && err.code === "ENOENT") {
          const parent = dirname(probe);
          if (parent === probe) break; // ルートまで辿った(全て未存在)
          probe = parent;
          continue;
        }
        throw err;
      }
    }
    return full;
  }

  // 書き込み系ツール(write_file/edit_file)専用: safePathに加えてstate/を拒否
  function safeWritePath(p) {
    const full = safePath(p);
    assertNotState(full, p);
    return full;
  }

  // 承認制ゲート: 禁止パターンは即拒否、要承認パターンはUI承認を待つ
  // 監査領域(state/)保護: bash経由での監査台帳・ボードJSONL等の改ざんを拒否する。
  // 完全な解析は不可能だが、state/ へのパス参照 + 書き込み指示子の組合せを検出して拒否し、
  // 改ざんを高コスト化する(監査回避経路の主要穴を塞ぐ)。
  const WRITE_INDICATORS = [">>", ">", "tee ", "cp ", "mv ", "rm ", "truncate", "dd ", "sed -i", "perl -i", "unlink"];
  function auditTampering(command) {
    const norm = String(command ?? "");
    const stateRef = /(^|[\s"'`(;&|])(\.?\/)*state\//.test(norm) || /(^|[\s"'(;&|])state(["\s;&|)]|$)/.test(norm);
    if (!stateRef) return null;
    // リダイレクト(> / >>)は「> state/...」の形で直後対象を見る
    if (/>>\s*\S*state\//.test(norm) || /(^|[^>])>\s*\S*state\//.test(norm)) {
      return norm.includes(">>") ? ">>" : ">";
    }
    // tee/cp/mv/rm 等は書き込みコマンドそのものなので、state/ 参照と同居したら拒否する。
    // (「ls state/」等の読み取りでは書き込み指示子が現れないため影響なし)
    const hit = WRITE_INDICATORS.find((w) => w !== ">" && w !== ">>" && norm.includes(w));
    if (hit) return hit;
    return null;
  }

  async function gatedBash(command, timeoutMs) {
    // worktreeエージェントのmain書込拒否(#8): write/editはsafePathでworkspace外を既に拒否済みだが、
    // bash経由の絶対パス書込は文字列として検出する。読み取り(cd/cat/diff main)は許可する
    if (mainWorkspace && WRITE_INDICATORS.some((w) => String(command).includes(w)) && String(command).includes(mainWorkspace)) {
      bus.emit("permission.denied", { agent: agent.id, command });
      return { ok: false, text: "このコマンドは拒否されました(メインワークスペースへの書き込み操作を検出)。あなたの作業ディレクトリ(worktree)内でのみ作業してください。成果の反映は finish_task が行います。" };
    }
    const tamper = auditTampering(command);
    if (tamper) {
      bus.emit("permission.denied", { agent: agent.id, command });
      return { ok: false, text: `このコマンドは拒否されました(監査領域 state/ への書き込み操作「${tamper.trim()}」を検出)。監査台帳は改変できません。` };
    }
    if (gate) {
      const verdict = await gate.check(command);
      if (!verdict.allowed) {
        bus.emit("permission.denied", { agent: agent.id, command });
        return { ok: false, text: `このコマンドは拒否されました(${verdict.reason})。別の安全な方法で作業を続けてください。` };
      }
    }
    // 事後検知: 変数展開($d/…)やbase64等の迂回で事前チェックを素通りした書き込みを、
    // 実行前後の state/ スナップショット比較で検出する(実行は取り消せないため可視化が目的)。
    const before = snapshotState();
    const res = await runCommand({ command, cwd: workspace, timeoutMs, outputLimit: BASH_OUTPUT_LIMIT });
    const after = snapshotState();
    const changed = diffSnapshot(before, after);
    if (changed.length > 0) {
      bus.emit("permission.denied", { agent: agent.id, command, stateChanged: changed });
      res.ok = false;
      res.text = `${res.text}
[警告] このコマンドは監査領域 state/ 配下を変更しました(${changed.join(", ")})。state/ への書き込みは禁止されています。監査台帳の改変は検出・記録されます。`;
    }
    return res;
  }

  // state/ 配下のファイル一覧+サイズ+mtimeのスナップショット(事後改ざん検知用)
  function snapshotState() {
    const root = join(workspace, "state");
    const out = new Map();
    const walk = (d) => {
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          try {
            const st = statSync(p);
            out.set(p, `${st.size}:${st.mtimeMs}`);
          } catch { /* 消えたファイルは無視 */ }
        }
      }
    };
    walk(root);
    return out;
  }

  function diffSnapshot(before, after) {
    // 表示はスラッシュ区切りに統一(Windowsのバックスラッシュを正規化)
    const rel = (p) => {
      const r = workspace ? p.slice(workspace.length + 1) : p;
      return r.split(/\\|\//).join("/");  };
    const changed = [];
    for (const [p, v] of after) {
      if (before.get(p) !== v) changed.push(rel(p));
    }
    for (const p of before.keys()) {
      if (!after.has(p)) changed.push(rel(p));
    }
    return changed;
  }

  return { specs, execute, detectShell };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// glob(例: *.mjs、src/**/*.js)を正規表現へ。** は任意の深さ、* はパス区切りをまたがない
function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += "(?:.*)";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?()+[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`(?:^|/)${re}$`, "i");
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
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
