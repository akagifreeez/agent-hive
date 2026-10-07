// キャッシュ済み入力トークンの計測(G9・dsh-vs-hive比較doc):
// 3アダプタのusage正規形にcachedTokensが載り、プロバイダ未報告は0でなくnullになること。
// GLM実測(2026-10-06プローブ)では prompt_tokens_details.cached_tokens が常に返る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUsage } from "../src/model/openai.js";
import { anthropicUsage } from "../src/model/anthropic-messages.js";
import { codexUsage } from "../src/model/openai-chatgpt.js";

test("usage-cached: openai-completions形はprompt_tokens_details.cached_tokensを拾う", () => {
  const u = extractUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 5 } });
  assert.equal(u.cachedTokens, 80);
  assert.equal(u.promptTokens, 100);
  assert.equal(u.reasoningTokens, 5);
});

test("usage-cached: 未報告はnull(0と未報告を区別する)", () => {
  assert.equal(extractUsage({ prompt_tokens: 10, completion_tokens: 1 }).cachedTokens, null);
  assert.equal(extractUsage(null).cachedTokens, null);
});

test("usage-cached: anthropic形はcache_read_input_tokensがキャッシュヒット", () => {
  const u = anthropicUsage({ input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 20 });
  assert.equal(u.cachedTokens, 500);
  assert.equal(anthropicUsage({ input_tokens: 1, output_tokens: 1 }).cachedTokens, null);
});

test("usage-cached: chatgpt-responses形はinput_tokens_details.cached_tokensを拾う", () => {
  const u = codexUsage({ input_tokens: 200, output_tokens: 40, input_tokens_details: { cached_tokens: 150 } });
  assert.equal(u.cachedTokens, 150);
  assert.equal(codexUsage({ input_tokens: 5, output_tokens: 1 }).cachedTokens, null);
});
