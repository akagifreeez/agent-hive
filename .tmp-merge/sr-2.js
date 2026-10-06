// 裏ログ(session-log/session.jsonl)の集計(G2・dsh-vs-hive比較doc)。
// G1のレコードはペイロード全体を含んで大きいため、行はストリームで読んで小さな数値だけを
// 取り出し、メモリに保持しない。maxRecords 件で打ち切る(現行ファイルの先頭から。ログが回転で
// 大きくなった段階で末尾読みへ拡張する課題)。
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { aggregateCacheHits } from "./usage.js";

const ROTATED_RE = /^session-\d{4}-\d{2}-\d{2}T.*\.jsonl$/;

/** 新しい順(current→回転の新しいもの)でファイル一覧を作る */
export function sessionLogFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  const rotated = readdirSync(dir).filter((f) => ROTATED_RE.test(f)).sort().reverse();
  const current = existsSync(join(dir, "session.jsonl")) ? ["session.jsonl"] : [];
  return [...current, ...rotated].map((f) => join(dir, f));
}

async function* records(files) {
  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try { yield JSON.parse(t); } catch { /* 壊れた行は無視 */ }
    }
  }
}

/**
 * session-log/ を集計する。返すのはレコード単位の統計だけで、本文は読み捨てる。
 * @param {string} dir session-log/ディレクトリ(無ければ空結果)
 * @param {{maxRecords?: number}} [opts] 直近何レコードを集計するか
 */
export async function summarizeSessionDir(dir, { maxRecords = 2000 } = {}) {
  const files = sessionLogFiles(dir);
  const byAgent = new Map();
  const blank = () => ({
    calls: 0, errors: 0, compactions: 0,
    promptTokens: 0, completionTokens: 0, reasoningTokens: 0,
    cachedTokens: null, cachedCalls: 0, msSum: 0, firstTs: null, lastTs: null,
  });
  let scanned = 0;
  for await (const rec of records(files)) {
    if (scanned >= maxRecords) break;
    scanned += 1;
    const s = byAgent.get(rec.agent ?? "?") ?? blank();
    if (rec.kind === "compact") s.compactions += 1;
    else s.calls += 1;
    if (rec.error) s.errors += 1;
    const u = rec.response?.usage;
    if (u) {
      s.promptTokens += u.promptTokens ?? 0;
      s.completionTokens += u.completionTokens ?? 0;
      s.reasoningTokens += u.reasoningTokens ?? 0;
      if (typeof u.cachedTokens === "number") {
        s.cachedTokens = (s.cachedTokens ?? 0) + u.cachedTokens;
        s.cachedCalls += 1;
      }
    }
    if (typeof rec.ms === "number") s.msSum += rec.ms;
    if (rec.ts) { s.firstTs = s.firstTs ?? rec.ts; s.lastTs = rec.ts; }
    byAgent.set(rec.agent ?? "?", s);
  }
  const agents = [...byAgent.entries()].map(([agent, s]) => ({
    agent, ...s,
    tokPerSec: s.msSum > 0 ? Math.round((s.completionTokens / (s.msSum / 1000)) * 10) / 10 : null,
    // キャッシュ命中率: openai-completions(GLM)はpromptにキャッシュが含まれるので有効。
    // Anthropicのinput_tokensは非キャッシュ分のみなので、cachedがpromptを超える場合は算出しない
    cacheHitRatio: s.cachedTokens != null && s.promptTokens > 0 && s.cachedTokens <= s.promptTokens
      ? Math.round((s.cachedTokens / s.promptTokens) * 1000) / 1000
      : null,
  })).sort((a, b) => (b.calls + b.compactions) - (a.calls + a.compactions));
  return { scanned, window: maxRecords, files: files.length, agents, cacheHits: aggregateCacheHits(cacheRows) };
}
