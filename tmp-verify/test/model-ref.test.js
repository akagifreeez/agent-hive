// ModelRef("provider/model")の解析と整形
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModelRef, formatModelRef } from "../src/model/ref.js";

test("parseModelRef: provider/model をそのまま分解する", () => {
  assert.deepEqual(parseModelRef("zai/glm-5.3-flash"), { provider: "zai", model: "glm-5.3-flash" });
});

test("parseModelRef: ベアIDは既定プロバイダで補完する", () => {
  assert.deepEqual(parseModelRef("glm-5.3-flash", "zai"), { provider: "zai", model: "glm-5.3-flash" });
});

test("parseModelRef: ベアIDで補完先が無い場合はエラー", () => {
  assert.throws(() => parseModelRef("glm"), /プロバイダの指定がありません/);
});

test("parseModelRef: 不正形式(空プロバイダ・空モデル・非文字列)はエラー", () => {
  assert.throws(() => parseModelRef("/glm"), /形式が不正/);
  assert.throws(() => parseModelRef("zai/"), /形式が不正/);
  assert.throws(() => parseModelRef(""), /空です/);
  assert.throws(() => parseModelRef(null), /文字列ではありません/);
});

test("formatModelRef: parseと往復する", () => {
  assert.equal(formatModelRef({ provider: "zai", model: "glm-5.3" }), "zai/glm-5.3");
});
