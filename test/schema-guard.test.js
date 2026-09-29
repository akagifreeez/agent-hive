// 構造化出力のスキーマ強制(イシュー#9):
// schema-guard(validateSchema/findPlaceholders/parseJsonLoose/guardJson)と
// ワークフローAPI経由(api.validate/api.parseJson/api.withGuard)の動作を検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createWorkflowApi } from "../src/engine/workflow.js";
import { validateSchema, findPlaceholders, parseJsonLoose, checkStructured, guardJson } from "../src/engine/schema-guard.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-schema-"));
}

const PERSON_SCHEMA = {
  type: "object",
  required: ["name", "age"],
  properties: { name: { type: "string" }, age: { type: "integer" }, tags: { type: "array", items: { type: "string" } } },
};

test("validateSchema: 型・必須キー・enum・配列要素を検証する", () => {
  assert.deepEqual(validateSchema({ name: "a", age: 3 }, PERSON_SCHEMA), []);
  assert.deepEqual(validateSchema({ name: "a", age: 3, tags: ["x", "y"] }, PERSON_SCHEMA), []);
  const bad = validateSchema({ age: 1.5 }, PERSON_SCHEMA);
  assert.ok(bad.some((r) => r.includes("$.name") && r.includes("欠損")), "欠損キーを検出");
  assert.ok(bad.some((r) => r.includes("$.age") && r.includes("integer")), "整数違反を検出");
  assert.ok(validateSchema("not-object", PERSON_SCHEMA).length > 0, "object以外を拒否");
  assert.deepEqual(validateSchema({ name: 1, age: 1 }, PERSON_SCHEMA).filter((r) => r.includes("$.name")).length, 1, "nameの型違反");
});

test("validateSchema: schema未指定や未対応typeは制約しない(過剰制約にしない)", () => {
  assert.deepEqual(validateSchema({ any: "thing" }, null), []);
  assert.deepEqual(validateSchema({ any: "thing" }, { type: "custom" }), []);
});

test("findPlaceholders: 仮値・1文字値を検出する(欠損キーはrequired側)", () => {
  assert.ok(findPlaceholders({ a: "test" }).some((r) => r.includes("$.a")), '仮値"test"');
  assert.ok(findPlaceholders({ a: "TODO" }).some((r) => r.includes("$.a")), "大文字小文字を無視");
  assert.ok(findPlaceholders({ a: ["x", "ok"] }).some((r) => r.includes("$.a[0]")), "1文字値(配列要素も再帰)");
  assert.deepEqual(findPlaceholders({ a: "hello world" }), [], "正常値は無違反");
  assert.deepEqual(findPlaceholders({ a: "k" }, { forbidSingleChar: false }), [], "1文字許容オプション");
});

test("parseJsonLoose: コードフェンス・前置き文を許容する", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a": 1}\n```').value, { a: 1 });
  assert.deepEqual(parseJsonLoose('結果はこちら: {"a": [1,2]} です').value, { a: [1, 2] });
  assert.equal(parseJsonLoose("").ok, false);
  assert.equal(parseJsonLoose("JSONではありません").ok, false);
});

test("checkStructured: スキーマ+placeholderの統合判定", () => {
  assert.equal(checkStructured({ name: "tac", age: 5 }, { schema: PERSON_SCHEMA }).ok, true);
  const ng = checkStructured({ name: "test", age: 5 }, { schema: PERSON_SCHEMA });
  assert.equal(ng.ok, false);
  assert.ok(ng.reasons.some((r) => r.includes("仮値")));
});

test("guardJson: 不正応答をreasons添えで再走し、有効値で解決する", async () => {
  const attempts = ['{"name": "test", "age": 1}', "not json", '{"name": "ok", "age": 9}'];
  const logs = [];
  const value = await guardJson({
    run: (attempt) => attempts[attempt - 1],
    schema: PERSON_SCHEMA,
    log: (t) => logs.push(t),
  });
  assert.deepEqual(value, { name: "ok", age: 9 });
  assert.equal(logs.length, 2, "不正2回分のログ");
});

test("guardJson: 全滅時は最後の違反を添えて例外", async () => {
  await assert.rejects(
    () => guardJson({ run: () => '{"name": "x", "age": 1}', schema: PERSON_SCHEMA, maxAttempts: 2 }),
    /2回全て不正.*\$.name/,
  );
});

test("workflow api: validate/parseJson/withGuardがスキーマ強制を提供する", async () => {
  const bus = new Bus();
  new Board(bus);
  const logs = [];
  const tasks = new TaskBlackboard(mktmp(), bus);
  const api = createWorkflowApi({
    openThread: async () => {},
    closeThread: async () => {},
    say: () => {},
    tasks,
    log: (t) => logs.push(t),
  });
  // validate: 違反の説明配列
  assert.ok(api.validate({ age: 1 }, PERSON_SCHEMA).some((r) => r.includes("$.name")));
  assert.deepEqual(api.validate({ name: "n", age: 2 }, PERSON_SCHEMA), []);
  // parseJson: ルーズパース
  assert.equal(api.parseJson('```json\n{"a": 1}\n```').ok, true);
  // withGuard: 1回目placeholder → 2回目で有効値(再走の証跡をログで確認)
  const value = await api.withGuard({
    schema: PERSON_SCHEMA,
    run: async (attempt) => (attempt === 1 ? '{"name": "test", "age": 4}' : '{"name": "real", "age": 4}'),
  });
  assert.deepEqual(value, { name: "real", age: 4 });
  assert.ok(logs.some((l) => l.includes("[schema-guard]") && l.includes("検証NG")), "ガード再走がworkflow.logへ流れる");
  rmSync(tasks.dir, { recursive: true, force: true });
});

test("workflow script: api.withGuardをスクリプトから使える(runWorkflowScript統合)", async () => {
  const calls = [];
  const api = {
    async withGuard(o) {
      const v = await o.run(1);
      calls.push(["withGuard", JSON.parse(v).name]);
      return JSON.parse(v);
    },
    async say(text) { calls.push(["say", text]); },
    log() {},
  };
  const script = join(mktmp(), "wf-schema.mjs");
  writeFileSync(script, `
    export default async (api) => {
      const data = await api.withGuard({
        schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        run: async () => JSON.stringify({ name: "from-script" }),
      });
      await api.say("ok: " + data.name);
    };
  `);
  const { runWorkflowScript } = await import("../src/engine/workflow.js");
  await runWorkflowScript({ path: script, api, timeoutMs: 5000 });
  assert.deepEqual(calls, [["withGuard", "from-script"], ["say", "ok: from-script"]]);
  rmSync(script, { force: true });
});
