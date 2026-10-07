// タスクblackboard。workspace/tasks/{open,claimed,done} 配下のMarkdownファイルが
// 仕事そのもの。claimは「open→claimedへのrename」=同一ボリュームで原子的なので、
// 複数エージェントが同時に請求しても二重請求が起きない。
import { mkdirSync, readdirSync, renameSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * タスク1件の契約(list()/UI/LLM注入の共通形)。実体は tasks/{open,claimed,done} のMarkdown。
 * @typedef {Object} TaskInfo
 * @property {string} state 状態("open"|"claimed"|"done")
 * @property {string} id タスクid(ファイル名から.mdを除いたもの)
 * @property {string|null} agent 請求中エージェントid(openのときnull)
 * @property {string|null} role 担当ロール(impl/review/lead等)。null=誰でも請求可
 * @property {string|null} project 文脈(取り組み名=スレッド名)
 * @property {string} acceptance 受け入れ基準
  * @property {string[]} dependsOn 依存タスクid(未完了があるとclaim不可)
 * @property {string|null} model リーダーが指定した代替モデルref(#12)。null=既定モデル
 * @property {boolean} blocked 依存未完了でclaim不可のときtrue(openのみ計算)
 * @property {string} summary 本文の要約(先頭の実質行)
 * @property {string} path タスクファイルのパス
 */

export class TaskBlackboard {
  constructor(workspace, bus = null) {
    this.dir = join(workspace, "tasks");
    this.open = join(this.dir, "open");
    this.claimed = join(this.dir, "claimed");
    this.done = join(this.dir, "done");
    this.bus = bus;
    this.createdBy = new Map(); // taskId => 起票者agentId(退場時掃除用の起票記録)
    for (const d of [this.open, this.claimed, this.done]) mkdirSync(d, { recursive: true });
  }

  seed(tasks) {
    for (const t of tasks ?? []) this.create(t);
  }

  /**
   * 発見器などが直接タスクを投入する。projectは文脈(=どの取り組みの仕事か)のタグ。
   * acceptanceは受け入れ基準(完了とみなす条件)。途中参加するワーカーでも完成形を誤解しないようにする
   * @param {{id: string, role?: string|null, body?: string, project?: string, acceptance?: string, dependsOn?: string[], createdBy?: string|null, model?: string|null}} t
   * @returns {boolean} 既存のidならfalse
   */
  // 発見器などが直接タスクを投入する。projectは文脈(=どの取り組みの仕事か)のタグ。
  // acceptanceは受け入れ基準(完了とみなす条件)。途中参加するワーカーでも完成形を誤解しないようにする
  create({ id, role, body, project = "", acceptance = "", dependsOn = [], createdBy = null, model = null }) {
    const f = join(this.open, `${id}.md`);
    if (existsSync(f)) return false;
    const meta = metaLines(project, role, acceptance, dependsOn, model);
    writeFileSync(f, `${meta}\n${body ?? ""}\n`);
    if (createdBy) this.createdBy.set(id, createdBy);
    this.bus?.emit("task.created", { taskId: id, project: String(project ?? "") });
    return true;
  }

  // スポーンなどで最初から請求済みとしてタスクを投入する(ブリーフ=そのエージェントの担当)
  assign({ agentId, taskId, body, project = "", model = null }) {
    const f = join(this.claimed, `${agentId}--${taskId}.md`);
    if (existsSync(f)) return false;
    const meta = metaLines(project, null, "", [], model);
    writeFileSync(f, `${meta}\n${body ?? ""}\n`);
    return true;
  }

  // 指定idのタスクがopen/claimedのどこかに存在するか(自動仕事の二重生成防止)
  existsOpenOrClaimed(id) {
    if (existsSync(join(this.open, `${id}.md`))) return true;
    return readdirSync(this.claimed).some((f) => f === `${id}.md` || f.endsWith(`--${id}.md`));
  }

  // 未着手/作業中の自動タスクを解決済みへ(テスト復旧時など)。noteはファイル末尾に追記。
  autoResolve(id, note) {
    const openFile = join(this.open, `${id}.md`);
    if (existsSync(openFile)) {
      appendNote(openFile, note);
      renameSync(openFile, join(this.done, `auto--${id}.md`));
      this.bus?.emit("task.autoResolved", { taskId: id });
      return true;
    }
    const claimedFile = readdirSync(this.claimed).find((f) => f.endsWith(`--${id}.md`));
    if (claimedFile) {
      const p = join(this.claimed, claimedFile);
      appendNote(p, note);
      renameSync(p, join(this.done, `auto--${claimedFile}`));
      this.bus?.emit("task.autoResolved", { taskId: id });
      return true;
    }
    return false;
  }

  // 指定エージェントが起票した未完了タスク(open/claimed)を掃除してdoneへ。
  // 対象: createdBy記録のあるもの + spawn-*管理タスク(自分のブリーフ自体)。
  // 他人が起票したタスクは掃除しない(誰かの仕事を消さない)。
  autoResolveCreatedBy(agentId, note = null) {
    const cleaned = [];
    const own = (taskId) => taskId.startsWith("spawn-") && taskId.includes(agentId)
      || this.createdBy.get(taskId) === agentId;
    for (const f of readdirSync(this.open).filter((x) => x.endsWith(".md"))) {
      const taskId = f.replace(/\.md$/, "");
      if (!own(taskId)) continue;
      if (this.autoResolve(taskId, note)) cleaned.push(taskId);
    }
    for (const f of readdirSync(this.claimed).filter((x) => x.endsWith(".md"))) {
      const base = f.replace(/\.md$/, "");
      const idx = base.indexOf("--");
      const holder = base.slice(0, idx);
      const taskId = base.slice(idx + 2);
      if (holder !== agentId || !own(taskId)) continue;
      if (this.autoResolve(taskId, note)) cleaned.push(taskId);
    }
    return cleaned;
  }

  // role一致を優先して請求(無ければrole指定なし)。opts.projectで文脈(プロジェクト)を絞れる——
  // 指定した文脈のタスクだけを請求対象にするので、別の取り組みのタスクと混ざらない。
  // 文脈内に何も無い場合、発見器起票の共通仕事(fix-/review-/distill-)へだけフォールバックする
  // (放置されると誰にも消化されないため。ユーザー/他プロジェクトのタスクは混ざらせない)。
  // 依存が全部doneならtrue。depends_onに未完了タスクがあるopenはclaimできない(イシュー#2)。
  // 自己依存や壊れたグラフ(循環)で永遠に着手できない状態を作らないため、
  // 依存元が自分自身 / 未完了依存が全て自分自身のときは依存を無視してtrueを返す。
  /** @param {string} file open配下のタスクファイル名 @returns {boolean} */
  canClaim(file) {
    const selfId = file.replace(/\.md$/, "");
    const meta = readMeta(join(this.open, file));
    const deps = (meta.dependsOn ?? []).filter((d) => d !== selfId);
    if (!deps.length) return true;
    return !deps.some((d) => this.isUnresolved(d));
  }

  // 指定idが未解決(open/claimed)ならtrue。doneと存在しないidは解決済み扱い(依存として無効)
  isUnresolved(id) {
    if (existsSync(join(this.open, `${id}.md`))) return true;
    return readdirSync(this.claimed).some((f) => f === `${id}.md` || f.endsWith(`--${id}.md`));
  }

  /**
   * タスクを請求する(open→claimedへの原子的rename)。roleは「タスクrole===自分のrole」
   * または「タスクrole無し」のときだけ請求できる(不一致はclaimMissの診断文面で教える)。
   * @param {{id: string, role: string|null}} agent 請求するエージェント
   * @param {{project?: string}} [opts] project指定時はその文脈のタスクに絞る(無ければ共通仕事へフォールバック)
   * @returns {{id: string, body: string}|null} 請求できたらタスク情報、できなければnull
   */
  claim(agent, opts = {}) {
    const attempt = (files) => {
      for (const pass of [(r) => r === agent.role, (r) => r === null]) {
        for (const f of files) {
          if (!pass(readMeta(join(this.open, f)).role)) continue;
          if (!this.canClaim(f)) continue; // 依存未完了は立候補しない(次の候補へ)
          const src = join(this.open, f);
          const dst = join(this.claimed, `${agent.id}--${f}`);
          try {
            renameSync(src, dst);
            const id = f.replace(/\.md$/, "");
            this.bus?.emit("task.claimed", { agent: agent.id, taskId: id });
            return { id, body: readFileSync(dst, "utf8") };
          } catch {
            // 先を越された。次の候補へ。
          }
        }
      }
      return null;
    };
    const all = readdirSync(this.open).filter((f) => f.endsWith(".md")).sort();
    const scoped = opts.project ? all.filter((f) => readMeta(join(this.open, f)).project === opts.project) : all;
    const got = attempt(scoped);
    if (got) return got;
    if (!opts.project) return null;
    const shared = all.filter((f) => /^(fix-|review-|distill-)/.test(f));
    return attempt(shared);
  }

  finish(agent, taskId) {
    const src = join(this.claimed, `${agent.id}--${taskId}.md`);
    const dst = join(this.done, `${agent.id}--${taskId}.md`);
    try {
      renameSync(src, dst);
      this.bus?.emit("task.finished", { agent: agent.id, taskId });
      return true;
    } catch {
      return false;
    }
  }

  // 請求中タスク一覧。project等のメタを含める(tools.jsの検証タスク起票がprojectを引き継ぐのに使う)
  claimedBy(agentId) {
    const files = readdirSync(this.claimed).filter((f) => f.startsWith(`${agentId}--`) && f.endsWith(".md"));
    return files.map((f) => {
      const meta = readMeta(join(this.claimed, f));
      return {
        id: f.replace(/\.md$/, "").slice(agentId.length + 2),
        role: meta.role,
        project: meta.project,
        acceptance: meta.acceptance ?? "",
        dependsOn: meta.dependsOn ?? [],
        model: meta.model ?? null,
        body: readFileSync(join(this.claimed, f), "utf8"),
      };
    });
  }

  // 担当者が消える終わり方(予算停止/エラー/継続不能)のとき、請求中をopenへ戻す。
  // 戻さないとタスクが請求者ごと凍結され、誰にも再開されない(発見器も「未解決あり」と扱う)。
  release(agentId, note = null) {
    const files = readdirSync(this.claimed).filter((f) => f.startsWith(`${agentId}--`) && f.endsWith(".md"));
    const released = [];
    for (const f of files) {
      const taskId = f.replace(/\.md$/, "").slice(agentId.length + 2);
      const src = join(this.claimed, f);
      const dst = join(this.open, `${taskId}.md`);
      try {
        if (note) appendNote(src, note);
        renameSync(src, dst);
        this.bus?.emit("task.released", { agent: agentId, taskId });
        released.push(taskId);
      } catch {
        // 先に他者が動いた場合等。次のファイルへ。
      }
    }
    return released;
  }

  snapshot() {
    const list = (dir) => readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    return { open: list(this.open), claimed: list(this.claimed), done: list(this.done) };
  }

  // UIのタスク管理パネル用。1件ごとに状態/担当/文脈/要約/ファイルパスを返す(本文は必要時のみ取得)
  /**
   * 全タスクの一覧をUI/LLM向けの共通形で返す
   * @returns {{open: TaskInfo[], claimed: TaskInfo[], done: TaskInfo[]}}
   */
  list() {
    // メタ行(role:/project:)と空行を除いた本文
    const bodyOf = (raw) => {
      const lines = raw.split("\n");
      let i = 0;
      while (i < lines.length && lines[i].trim()) i++;
      if (i < lines.length) i++;
      return lines.slice(i).join("\n");
    };
    // 要約は最初の実質行([解放]等のシステムノートは飛ばす)
    const summarize = (body) => {
      const line = body.trim().split("\n").find((l) => l.trim() && !l.trim().startsWith("[")) ?? "(本文なし)";
      return line.trim().slice(0, 90);
    };
    const open = readdirSync(this.open).filter((f) => f.endsWith(".md")).sort().map((f) => {
      const meta = readMeta(join(this.open, f));
      const deps = meta.dependsOn ?? [];
      return { state: "open", id: f.replace(/\.md$/, ""), agent: null, role: meta.role, project: meta.project, acceptance: meta.acceptance ?? "", dependsOn: deps, model: meta.model ?? null, blocked: deps.length > 0 && !this.canClaim(f), summary: summarize(bodyOf(readFileSync(join(this.open, f), "utf8"))), path: `tasks/open/${f}` };
    });
    const claimed = readdirSync(this.claimed).filter((f) => f.endsWith(".md")).sort().map((f) => {
      const meta = readMeta(join(this.claimed, f));
      const base = f.replace(/\.md$/, "");
      const idx = base.indexOf("--");
      return { state: "claimed", id: base.slice(idx + 2), agent: base.slice(0, idx), role: meta.role, project: meta.project, acceptance: meta.acceptance ?? "", dependsOn: meta.dependsOn ?? [], model: meta.model ?? null, blocked: false, summary: summarize(bodyOf(readFileSync(join(this.claimed, f), "utf8"))), path: `tasks/claimed/${f}` };
    });
    const done = readdirSync(this.done).filter((f) => f.endsWith(".md")).sort().map((f) => {
      const base = f.replace(/\.md$/, "");
      const idx = base.indexOf("--");
      const meta = readMeta(join(this.done, f));
      return { state: "done", id: base.slice(idx + 2), agent: base.slice(0, idx), role: null, project: meta.project, acceptance: meta.acceptance ?? "", dependsOn: meta.dependsOn ?? [], model: meta.model ?? null, blocked: false, summary: summarize(bodyOf(readFileSync(join(this.done, f), "utf8"))), path: `tasks/done/${f}` };
    });
    return { open, claimed, done };
  }

  // 文脈(プロジェクト)の付け替え。既存タスクを後からグルーピングする(UIの[移動])。
  // relPathはlist()が返す tasks/<state>/<file>.md 形式のみ許容(脱出防止)。
  setProject(relPath, project) {
    const m = String(relPath ?? "").match(/^tasks[\\/](open|claimed|done)[\\/]([A-Za-z0-9._-]+\.md)$/);
    if (!m) return false;
    const file = join(this.dir, m[1], m[2]);
    const proj = String(project ?? "").trim().replace(/[\r\n]/g, "").slice(0, 60);
    try {
      const lines = readFileSync(file, "utf8").split("\n");
      let i = 0;
      const metaBlock = [];
      while (i < lines.length && lines[i].trim()) metaBlock.push(lines[i++]);
      if (i < lines.length) i++; // メタの後の空行を飛ばす
      const kept = metaBlock.filter((l) => !l.startsWith("project: "));
      const head = [...(proj ? [`project: ${proj}`] : []), ...kept];
      writeFileSync(file, (head.length ? [...head, ""] : []).concat(lines.slice(i)).join("\n"));
      return true;
    } catch {
      return false;
    }
  }

  // 1件だけ解放(claimed→open)。UIからの個別解放用(releaseは担当者の全件)
  releaseOne(agentId, taskId, note = null) {
    const src = join(this.claimed, `${agentId}--${taskId}.md`);
    const dst = join(this.open, `${taskId}.md`);
    try {
      if (note) appendNote(src, note);
      if (existsSync(dst)) return false; // 同idのopenが既にある(手動投入等)場合は壊さない
      renameSync(src, dst);
      this.bus?.emit("task.released", { agent: agentId, taskId });
      return true;
    } catch {
      return false;
    }
  }

  // 未着手タスクを中止としてdoneへ(open→done)。削除せず履歴に残す
  cancel(taskId, note = "[中止] ユーザーがUIから中止") {
    const src = join(this.open, `${taskId}.md`);
    try {
      appendNote(src, note);
      renameSync(src, join(this.done, `you--${taskId}.md`));
      this.bus?.emit("task.cancelled", { taskId });
      return true;
    } catch {
      return false;
    }
  }

  // 完了タスクを再度openへ(done→open)。UIからの再開用
  reopen(taskId, note = "[再開] ユーザーがUIから再open") {
    const file = readdirSync(this.done).filter((f) => f.endsWith(`--${taskId}.md`)).sort().pop();
    if (!file) return false;
    const src = join(this.done, file);
    const dst = join(this.open, `${taskId}.md`);
    try {
      if (existsSync(dst)) return false;
      appendNote(src, note);
      renameSync(src, dst);
      this.bus?.emit("task.created", { taskId });
      return true;
    } catch {
      return false;
    }
  }
}

// メタ行(role:/project:/acceptance:)は先頭の空行までに置く。旧形式(role行のみ)も読める。
// tools.jsのgather_context絞込でも使うのでexportする。
// create_task時の重複検知。新タスク本文と既存タスク本文から path 風トークンを抽出し
// 比較する。共有ファイルがあれば [{ taskId, files }] を、無ければ null を返す。
// 誤検知防止: バージョン表記(v6.6等)や拡張子なしの短い語は対象外。メタ行は除去してから抽出。
export function detectTaskOverlap(newBody, tasksList) {
  const stripMeta = (s) => String(s ?? "").replace(/^acceptance:\s*.*$/gm, "");
  const tokenRe = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|html|css|yml|yaml|sh|py|sql|txt)/g;
  const tokensOf = (body) => new Set(String(body ?? "").match(tokenRe) ?? []);
  const isNew = tokensOf(stripMeta(newBody));
  if (!isNew.size) return null;
  const hits = [];
  for (const t of tasksList ?? []) {
    const shared = [...tokensOf(stripMeta(t.body))].filter((f) => isNew.has(f));
    if (shared.length) hits.push({ taskId: t.id, files: shared });
  }
  return hits.length ? hits : null;
}

export function readMeta(file) {
  try {
    const meta = { role: null, project: "", acceptance: "", dependsOn: [], model: null };
    for (const l of readFileSync(file, "utf8").split("\n")) {
      if (!l.trim()) break;
      const r = l.match(/^role:\s*(.+)$/);
      if (r) meta.role = r[1].trim() || null;
      const p = l.match(/^project:\s*(.+)$/);
      if (p) meta.project = p[1].trim();
      const a = l.match(/^acceptance:\s*(.+)$/);
      if (a) meta.acceptance = a[1].trim();
      const d = l.match(/^depends_on:\s*(.+)$/);
      const m = l.match(/^model:\s*(.+)$/);
      if (m) meta.model = m[1].trim() || null;
      if (d) meta.dependsOn = String(d[1]).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      const mo = l.match(/^model:\s*(.+)$/);
      if (mo) meta.model = mo[1].trim() || null;
    }
    return meta;
  } catch {
    return { role: null, project: "", acceptance: "", dependsOn: [], model: null };
  }
}

// 依存のメタ行(idは英小文字数字とハイフンのみ=二重ハイフン区切りのファイル名を壊さない)
function dependsLine(dependsOn) {
  const ids = [...new Set((dependsOn ?? [])
    .map((s) => String(s ?? "").trim().replace(/[\r\n]/g, ""))
    .filter((s) => /^[a-z0-9][a-z0-9-]*$/.test(s)))];
  return ids.length ? `depends_on: ${ids.join(",")}` : "";
}
// タスク別モデル指定(イシュー#12)。refは provider/model 形式の緩い検証(パス区切りと記号のみ許容)
function modelLine(model) {
  const ref = String(model ?? "").trim().replace(/[\r\n]/g, "");
  if (!ref) return "";
  if (!/^[A-Za-z0-9._\/-]+$/.test(ref)) return "";
  return `model: ${ref.slice(0, 120)}`;
}

function metaLines(project, role, acceptance = "", dependsOn = [], model = null) {
  const lines = [];
  const proj = String(project ?? "").trim().replace(/[\r\n]/g, "");
  if (proj) lines.push(`project: ${proj.slice(0, 60)}`);
  if (role) lines.push(`role: ${role}`);
  // 受け入れ基準は1行(改行は空白へ潰す)でメタに持つ。claim本文にもそのまま載る
  const acc = String(acceptance ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (acc) lines.push(`acceptance: ${acc}`);
  const dep = dependsLine(dependsOn);
  if (dep) lines.push(dep);
  // リーダーが特定タスクだけ代替モデルを指定(#12)。1行メタ
  const mo = String(model ?? "").trim().replace(/[\r\n]/g, "");
  if (mo) lines.push(`model: ${mo.slice(0, 80)}`);
  return lines.length ? lines.join("\n") + "\n" : "";
}

function appendNote(file, note) {
  if (!note) return;
  try {
    writeFileSync(file, readFileSync(file, "utf8") + `\n\n---\n${note}\n`);
  } catch {}
}
