// RouterModel: ターン毎モデルルーティング(仕事の重さで軽量/ heavyweight を自動振り分け)。
// VS Code Copilotのauto model selection相当。既定モデル(軽量=Flash)はそのまま使い、
// 重い条件の呼出だけstrong側(glm-5.3)へ振る。
// - 追加のLLM呼出はしない(判定はchat()実引数と直近履歴の無料シグナルのみ)
// - 判定根拠("flash"|"5.3"+理由1語)をres.routerへ載せ、ループ側のusage-trace/
//   session-logへ流れる。記録はループ契約(loop.js)で行い、このクラスは記録しない
// - FallbackModelと共存する: Router → (選択されたモデル=FallbackModelならその中身) の順
// - 依存ゼロ(node内蔵のみ)
import { estimateTokens, defaultRouterConfig, routingDecision } from "./router-config.js";

/**
 * ターン毎ルーティングラッパー。chat()を呼ぶたびに routingDecision() で判定し、
 * 配下のモデル実体へ委譲する。FallbackModelと同型の「モデルのように振る舞うラッパー」。
 * 継承しないのは複数アダプタ(OpenAI/Anthropic/ChatGPT)を混在させるため
 * (アダプタ固有のプロパティ参照は委譲で吸収する)。
 */
export class RouterModel {
  /**
   * @param {{primary: Object, strong: Object, routing: Object, onRoute?: Function|null}} cfg
   *   primary: 軽量側(既定=flash)のモデル実体。strong: 重量側(glm-5.3)のモデル実体。
   *   routing: RoutingConfig(normalizeRoutingConfig()の出力。router-config.js参照) 形の正規化済設定
   *   (normalizeRoutingConfig()の出力)。enabled=falseなら全てprimaryへ委譲する(回帰)。
   *   role: 呼出元エージェントのロール(impl/review/verify/lead等)。review/verify等の
   *   heavyRolesに一致すると品質重視でstrong側へ振る。未指定なら判定から除外される。
   *   onRoute: 判定時に呼ばれるフック({selected, reason, ...})。テスト/ログ配線用。
   */
  constructor(/** @type {{primary: Object, strong: Object, routing?: Object|null, role?: string|null, onRoute?: Function|null}} */ { primary, strong, routing, role = null, onRoute = null }) {
    if (!primary) throw new Error("RouterModel: primaryモデルがありません");
    if (!strong) throw new Error("RouterModel: strongモデルがありません");
    this.primary = primary;
    this.strong = strong;
    this.routing = routing ?? defaultRouterConfig();
    this.role = typeof role === "string" && role ? role.toLowerCase() : null;
    this.onRoute = typeof onRoute === "function" ? onRoute : null;
    // 直近の品質シグナル(空応答/モデルエラー)の連続回数。重い側へ振る判断に使う
    this.qualityStrikes = 0;
    // 直近のプロンプトトークン実測(usage報告から)。次ターンの重さ判定に使う
    this.lastPromptTokens = 0;
    this.lastError = null;
  }

  /** 選択されたモデルで委譲する。フォールバック列があれば配下の順に試す(再帰包摂)。 */
  async delegate(model, opts) {
    const chain = [model, ...((model.fallbacks ?? []).filter((f) => f !== model))];
    let lastErr = null;
    for (const m of chain) {
      try {
        return await m.chat(opts);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** モデルとして振る舞う最小の窓口。FloadModelと同様、無名オブジェクトとしても機能する。 */
  get maxTokens() {
    return (this.currentModel() ?? this.primary).maxTokens;
  }

  /** ループ等から「いま選択されているモデル」を問われたときの実体(テスト/表示用)。 */
  currentModel() {
    if (this.routing?.enabled !== true) return this.primary;
    return this.pendingModel ?? this.primary;
  }

  async chat(opts = {}) {
    // 判定: 追加のLLM呼出なし。chat()実引数(メッセージ列・ツール数)と直近状態のみで決める
    const d = routingDecision(
      { messages: opts.messages, tools: opts.tools, role: opts.role ?? this.role },
      { lastPromptTokens: this.lastPromptTokens, qualityStrikes: this.qualityStrikes },
      this.routing,
    );
    const selected = d.heavy ? this.strong : this.primary;
    const reason = d.reason;
    this.lastDecision = { selected: d.heavy ? "5.3" : "flash", reason };
    this.onRoute?.({ selected: this.lastDecision.selected, reason });
    this.pendingModel = selected;
    try {
      const res = await this.delegate(selected, opts);
      // 品質シグナル: 空応答(テキストもツール呼出も無い)は重い側への引き上げ兆候
      const empty = !res?.content && !(res?.toolCalls?.length) && !(res?.usage?.completionTokens);
      if (empty) {
        this.qualityStrikes++;
        this.lastError = "empty-response";
      } else {
        this.qualityStrikes = 0;
      }
      // usage報告があれば次ターンの重さ判定の種にする
      if (res?.usage?.promptTokens) this.lastPromptTokens = res.usage.promptTokens;
      // 判定根拠を応答へ添える(ループ側のusage-trace/session-logへ流れる。resの他キーは壊さない)
      return { ...res, router: { selected: this.lastDecision.selected, reason, via: selected.model ?? null } };
      // モデルエラーも重い側への引き上げ兆候(次ターン判定に使う)。エラー自体は握りつぶさない
    } catch (err) {
      this.qualityStrikes++;
      this.lastError = err?.message ?? String(err);
      throw err;
    } finally {
      this.pendingModel = null;
    }
  }
}
