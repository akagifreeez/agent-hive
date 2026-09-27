// 実験: 単一エージェント vs 3エージェント並行の壁時計・トークン比較
// 使い方: node exp-compare.mjs single|hive
import { loadConfig } from "./src/config.js";
import { OpenAIModel } from "./src/model/openai.js";
import { runScenario } from "./src/runner.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { join as j } from "node:path";

const mode = process.argv[2] ?? "single";
const apiKey = readFileSync("D:/working/openrouter.key", "utf8").trim();

const ws = mkdtempSync(join(tmpdir(), `exp-${mode}-`));
const mkAgent = (id) => ({ id, displayName: id, role: "impl", personaPath: j(process.cwd(), "agents", `${id}.md`) });
const seedPkg = join(ws, "package.json");
writeFileSync(seedPkg, JSON.stringify({ name: "exp", private: true, type: "module", scripts: { test: "node --test utils/" } }, null, 1));

// 同一の2タスク(独立ファイル。並行でも競合しない)
const taskA = {
  id: "task-a", role: null, project: "",
  body: `utils/slug.js を新規作成し、関数 slugify(text) を export してください。仕様: ①前後の空白を除去 ②小文字化 ③英数字以外の連続を単一のハイフンに置換 ④先頭末尾のハイフンを除去。例: "Hello, World!" → "hello-world"、"  Foo_Bar  " → "foo-bar"、"A--B" → "a-b"、"42!" → "42"。テストも utils/slug.test.js に node:test で書き、上記4例を検証すること。完了条件: 自分のworktreeで node --test utils/ が通ること。`,
};
const taskB = {
  id: "task-b", role: null, project: "",
  body: `utils/chunk.js を新規作成し、関数 chunk(arr, size) を export してください。仕様: ①配列arrをsize個ずつの配列に分割 ②最後のチャンクは短くてもよい ③sizeが1未満の数値のとき TypeError。例: chunk([1,2,3,4,5], 2) → [[1,2],[3,4],[5]]、chunk([], 3) → []、chunk([1,2], 2) → [[1,2]]。テストも utils/chunk.test.js に node:test で書き、上記4例を検証すること。完了条件: 自分のworktreeで node --test utils/ が通ること。`,
};

const config = loadConfig();
config.workspace = ws;
config.worktrees = { dir: `${ws}-wt` };
config.model = { ...config.model, apiKey };
config.agents = mode === "single"
  ? [mkAgent("alpha")]
  : [mkAgent("alpha"), mkAgent("beta"), mkAgent("gamma")];
config.loop = { maxTurns: 14 };
config.runner = { timeoutSec: 600 };
config.discovery = { intervalSec: 3600, testCommand: null }; // 発見器は無効化(実験の変数を固定)
config.scenario = { name: `exp-${mode}`, seedFiles: [], tasks: [taskA, taskB] };

import { Bus } from "./src/engine/board.js";
const bus = new Bus();
console.log(`[${new Date().toISOString()}] 実験開始: mode=${mode} agents=${config.agents.length}`);
const t0 = Date.now();
const snap = await runScenario({
  config,
  modelFactory: () => new OpenAIModel(config.model),
  bus,
});
const wallSec = Math.round((Date.now() - t0) / 1000);

// 成果の検証: テストが実際に通るか
let testOk = false, testOut = "";
try {
  testOut = execFileSync("node", ["--test", "utils/"], { cwd: ws, encoding: "utf8", timeout: 30000 });
  testOk = /pass \d+/.test(testOut) && !/fail [1-9]/.test(testOut);
} catch (e) { testOut = String(e.stdout ?? e.message); testOk = /pass \d+/.test(testOut) && !/fail [1-9]/.test(testOut); }

writeFileSync("exp-board.json", JSON.stringify({ board: snap.board.map((b) => ({ from: b.from, text: String(b.text).slice(0, 300) })), results: snap.results, tasks: snap.tasks }, null, 1));
console.log("results:", JSON.stringify(snap.results).slice(0, 600));
const totals = snap.usage?.totals ?? { promptTokens: 0, completionTokens: 0, costUsd: 0 };
console.log(`[${new Date().toISOString()}] 結果 mode=${mode}`);
console.log(JSON.stringify({
  wallSec,
  tasksDone: snap.tasks.done.length,
  tasksClaimedLeft: snap.tasks.claimed.length,
  agents: config.agents.length,
  tokens: { prompt: totals.promptTokens ?? 0, completion: totals.completionTokens ?? 0 },
  costUsd: Math.round((totals.costUsd ?? 0) * 1000) / 1000,
  testsPass: testOk,
}, null, 1));
rmSync(ws, { recursive: true, force: true });
rmSync(`${ws}-wt`, { recursive: true, force: true });
process.exit(0);
