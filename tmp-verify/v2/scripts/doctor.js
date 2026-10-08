// 動作環境の診断: 設定/キー/モデル接続/シェル
import { loadConfig } from "../src/config.js";
import { OpenAIModel } from "../src/model/openai.js";
import { createTools } from "../src/engine/tools.js";

const config = loadConfig();
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "OK  " : "NG  "} ${name}${detail ? ` — ${detail}` : ""}`);
};

check("設定", true, `model=${config.model.model}, agents=${config.agents.map((a) => a.id).join(",")}`);
check("APIキー", Boolean(config.model.apiKey), config.model.apiKeyEnv ?? "apiKeyFile");

if (config.model.apiKey) {
  try {
    const res = await fetch(`${config.model.baseUrl}/models`, {
      headers: { authorization: `Bearer ${config.model.apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const data = await res.json();
      const ids = (data.data ?? []).map((m) => m.id);
      check("モデルAPI接続", true, ids.includes(config.model.model) ? `${config.model.model} は利用可能` : `${config.model.model} が一覧に無い(要確認)`);
    } else {
      check("モデルAPI接続", false, `HTTP ${res.status}`);
    }
  } catch (err) {
    check("モデルAPI接続", false, err.message);
  }
}

const { detectShell } = createTools({
  agent: { id: "x" }, workspace: config.workspace,
  board: { post: () => {}, wait: async () => null },
  tasks: { claim: () => null, finish: () => false, claimedBy: () => [] },
  bus: { emit: () => {}, on: () => {} },
});
check("シェル", true, `bashツールは ${await detectShell()} を使用`);

console.log(results.every(Boolean) ? "=== すべてOK ===" : "=== 要対応あり ===");
