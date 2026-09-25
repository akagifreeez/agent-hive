// UIプレビュー用: 実シナリオを走らせず、ダミー状態を流してUIを確認する。
// 使い方: node scripts/preview-ui.mjs  (90秒で自動終了)
import { loadConfig } from "../src/config.js";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";

const config = loadConfig();
const bus = new Bus();

await startUi({ config, modelFactory: () => ({ chat: async () => { throw new Error("preview"); } }), bus, autoStart: false });

// ダミー状態を流す(UIの見た目確認用)
bus.emit("scenario.started", { name: "stringutil", tasks: ["impl-upper", "impl-pad", "summarize-stringutil"] });
const agents = {
  alpha: { status: "working", turn: 8, lastTool: "bash", tokens: 23793, costUsd: 0.0017 },
  delta: { status: "working", turn: 6, lastTool: "read_file", tokens: 21473, costUsd: 0.0016 },
  beta: { status: "working", turn: 11, lastTool: "post_to_board", tokens: 37033, costUsd: 0.002 },
  gamma: { status: "waiting", turn: 4, lastTool: "wait_for_board", tokens: 17947, costUsd: 0.0003 },
};
for (const [id, a] of Object.entries(agents)) {
  bus.emit("agent.turn", { agent: id, turn: a.turn });
  bus.emit("tool.call", { agent: id, tool: a.lastTool, args: {} });
  bus.emit("usage", { agent: id, usage: { promptTokens: a.tokens, completionTokens: 200, costUsd: a.costUsd } });
  bus.emit("agent.status", { agent: id, status: a.status });
}
const posts = [
  { id: 1, from: "alpha", text: "impl-pad 完了: src/pad.js を実装(padCenter: 左右パッド、奇数余りは左少なめ)。`node --test tests/pad.test.mjs` 3/3 pass を確認。" },
  { id: 2, from: "delta", text: "impl-upper 完了: src/upper.js 実装(toUpperSnake: キャメル/ハイフン/連続区切り対応)。4/4 pass。" },
  { id: 3, from: "beta", text: "【レビュー結果】pad.js/upper.js を読み、自分でも動かして確認しました。良い点: 境界テストが網羅的。指摘1: padCenter の width が非数値の場合の挙動が未定義です。TypeError を投げる仕様にしてテストで固定することを提案します。" },
  { id: 4, from: "system", text: "[マージ] ベータ(beta) がタスク review-changes の成果を main へ取り込みました。" },
  { id: 5, from: "gamma", text: "【全体まとめ】両実装ともマージ済み。テスト7/7 pass を自分の環境で確認。残課題はなし。シナリオ完了と判断します。" },
];
for (const p of posts) bus.emit("board", p);
bus.emit("permission.request", { id: 1, command: "git push origin main", pattern: "git push" });

setTimeout(() => process.exit(0), 90000);
