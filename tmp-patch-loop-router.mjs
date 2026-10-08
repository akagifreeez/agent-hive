// パッチ1: loop.js — usage-trace/session-logへのrouter判定根拠の記録を追加
// RouterModelの応答に添付される res.router = {selected, reason, via} を記録する。
// 編集は行置換(完全一致)で行い、テンプレートリテラル/生改行の破壊を避ける。
import { readFileSync, writeFileSync } from "node:fs";

const p = "src/engine/loop.js";
let src = readFileSync(p, "utf8");
// LFへ正規化(書き出しもLF。git側は改行正規化されない生の差分になるが動作に影響なし)
if (src.includes("\r\n")) src = src.split("\r\n").join("\n");

function mustReplace(oldText, newText, label) {
  if (!src.includes(oldText)) {
    console.error("PATCH1 FAIL: 見つかりません: " + label);
    process.exit(1);
  }
  src = src.replace(oldText, newText);
}

// --- (A) usage-trace.jsonl のレコードへ router を追加 ---
// 対象: tokPerSec行(usage-trace.jsonlレコードの最終キー)
mustReplace(
  '        tokPerSec: chatMs > 0 ? (res.usage?.completionTokens ?? 0) / (chatMs / 1000) : null,\n        ctxChars, msgCount: messages.length,',
  '        tokPerSec: chatMs > 0 ? (res.usage?.completionTokens ?? 0) / (chatMs / 1000) : null,\n'
  + '        // モデルルーティングの判定根拠(RouterModel有効時のみセットされる)。無効時は省略(ログ肥大化防止)\n'
  + '        ...(res.router ? { router: res.router } : {}),\n'
  + '        ctxChars, msgCount: messages.length,',
  "usage-trace router",
);

// --- (B) sessionLog.append(kind:"chat") 成功応答レコードへ router を追加 ---
// 対象: response.searches行の次(searches行はusage-traceとは別の1箇所のみ)
mustReplace(
  '        toolCalls: res.toolCalls ?? [], usage: res.usage ?? null, searches: res.searches ?? null,\n      },',
  '        toolCalls: res.toolCalls ?? [], usage: res.usage ?? null, searches: res.searches ?? null,\n'
  + '        // モデルルーティングの判定根拠(選択+"flash"|"5.3"+理由1語)。RouterModel無効時は省略\n'
  + '        ...(res.router ? { router: res.router } : {}),\n      },',
  "session-log router",
);

writeFileSync(p, src, "utf8");
console.log("PATCH1 OK: loop.js へ router記録を追加");
