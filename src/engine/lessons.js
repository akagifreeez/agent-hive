// 監査ログ(state/audit.jsonl)の失敗パターン解析(教訓プローブの純関数部分)。
// 失敗エントリ(ok: false)を「ツール+正規化した教師文面」のシグネチャでグルーピングし、
// 時間窓内の件数が多い順に返す。hiveが実際に機能した改善経路(失敗→教師文面→
// 恒久ルール化)の発見側を自動化するのが目的。数値は # へ潰して同一パターンに
// まとめる(タイムアウトms・exitコードなどの差異を吸収して「同型の失敗」を掴む)。

/**
 * 失敗1件のシグネチャ(グルーピングの鍵)。ツール名+数値を潰した教師文面の先頭。
 * @param {{tool?: string, brief?: string}} entry
 * @returns {string}
 */
export function failureSignature(entry) {
  const brief = String(entry?.brief ?? "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${entry?.tool ?? "unknown"}: ${brief}`;
}

/**
 * シグネチャをタスクidに使える安定スラグへ(distill-lesson- の後ろに連結する部分)。
 * FNV-1a(32bit)ハッシュ+ツール名。安定なので再起動をまたいでも同一idになり、
 * done参照による恒久クールダウン(同じ失敗は1度だけ教訓化)が効く。
 * @param {string} signature
 * @returns {string}
 */
export function lessonSlug(signature) {
  let h = 2166136261;
  for (let i = 0; i < signature.length; i++) {
    h ^= signature.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const tool = String(signature.split(":")[0] ?? "")
    .toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "tool";
  return `${tool}-${(h >>> 0).toString(36)}`;
}

/**
 * 監査エントリ配列を失敗パターンへ集約する。
 * @param {{entries: Array<{ts?: string, tool?: string, ok?: boolean, brief?: string}>, windowMs: number, nowMs?: number, minCount?: number, maxExamples?: number}} o
 * @returns {Array<{signature: string, slug: string, tool: string, count: number, examples: string[]}>} 件数降順(minCount以上のみ)
 */
export function analyzeAuditFailures({ entries, windowMs, nowMs = Date.now(), minCount = 5, maxExamples = 3 }) {
  const groups = new Map();
  for (const e of entries ?? []) {
    if (!e || e.ok !== false) continue;
    const ts = Date.parse(String(e.ts ?? ""));
    if (Number.isFinite(ts) && nowMs - ts > windowMs) continue;
    const sig = failureSignature(e);
    if (!groups.has(sig)) {
      groups.set(sig, { signature: sig, slug: lessonSlug(sig), tool: String(e.tool ?? "unknown"), count: 0, examples: [] });
    }
    const g = groups.get(sig);
    g.count += 1;
    if (g.examples.length < maxExamples) g.examples.push(String(e.brief ?? "").replace(/\s+/g, " ").slice(0, 150));
  }
  return [...groups.values()].filter((g) => g.count >= minCount).sort((a, b) => b.count - a.count);
}
