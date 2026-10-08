// モデルカタログ: 構築(builtin+設定のマージ)・resolve・auth解決・旧形への合成
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalog, resolveModel, resolveAuthValue, legacyModelSection } from "../src/model/catalog.js";
import { loadConfig } from "../src/config.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-catalog-"));
}

test("buildCatalog: 内蔵が入り、設定で上書き・追加される", () => {
  const cat = buildCatalog({
    providers: {
      zai: { baseUrl: "https://override.example/v4", models: [{ id: "glm-x" }] },
      mine: { baseUrl: "https://mine.example/v1", api: "openai-completions", models: [{ id: "m1" }] },
    },
  });
  assert.equal(cat.providers.zai.baseUrl, "https://override.example/v4");
  assert.equal(cat.providers.zai.models.length, 1, "設定のmodels配列で置換");
  assert.ok(cat.providers.mine, "設定の新規プロバイダが追加される");
  assert.ok(cat.providers.zai.models[0].id === "glm-x");
});

test("resolveModel: ModelRef・ベアID(既定補完)・未指定(既定モデル)", () => {
  const cat = buildCatalog({ default: "zai/glm-5.3-flash" });
  assert.equal(resolveModel(cat, "zai/glm-5.3-flash").model.id, "glm-5.3-flash");
  assert.equal(resolveModel(cat, "glm-5.3-flash").provider.id, "zai", "ベアIDは既定プロバイダで補完");
  const byDefault = resolveModel(cat, null);
  assert.equal(byDefault.model.id, "glm-5.3-flash");
  assert.equal(byDefault.model.name, "GLM-5.3-Flash");
  assert.equal(byDefault.model.maxTokens, 4000);
});

test("resolveModel: カタログ行が無いモデルは既定値で解決できる", () => {
  const cat = buildCatalog({ default: "zai/glm-5.3-flash" });
  const s = resolveModel(cat, "zai/unknown-model");
  assert.equal(s.model.id, "unknown-model");
  assert.equal(s.model.maxTokens, 2000, "行が無ければカタログ既定");
  assert.equal(s.model.contextWindow, 200000);
});

test("resolveModel: ベアIDが内蔵カタログに一意一致する場合は既定と異なるプロバイダへ向く", () => {
  // defaultがzaiでも claude-haiku-4-5 は内蔵anthropicに一意一致する
  const cat = buildCatalog({ default: "zai/glm-5.3-flash" });
  assert.equal(resolveModel(cat, "claude-haiku-4-5").provider.id, "anthropic");
  assert.equal(resolveModel(cat, "glm-5.3-flash").provider.id, "zai", "既存のGLMベアIDは従来どおり");
});

test("resolveModel: 未知プロバイダはエラーで利用可能一覧を出す", () => {
  const cat = buildCatalog({ default: "zai/glm-5.3-flash" });
  assert.throws(() => resolveModel(cat, "nope/m"), /未知のプロバイダ "nope".*zai/s);
});

test("resolveAuthValue: value > env > file の順。fileはbaseDirsを順に試す", () => {
  const dir = mktmp();
  writeFileSync(join(dir, "k.key"), "file-key-123\n");
  assert.equal(resolveAuthValue({ auth: { file: "k.key" } }, ["/nonexistent", dir]), "file-key-123");
  const prev = process.env.HIVE_CATALOG_TEST_KEY;
  process.env.HIVE_CATALOG_TEST_KEY = "env-key-456";
  try {
    assert.equal(resolveAuthValue({ auth: { env: "HIVE_CATALOG_TEST_KEY", file: "k.key" } }, [dir]), "env-key-456");
    assert.equal(resolveAuthValue({ auth: { value: "direct-789", env: "HIVE_CATALOG_TEST_KEY" } }), "direct-789");
  } finally {
    if (prev === undefined) delete process.env.HIVE_CATALOG_TEST_KEY;
    else process.env.HIVE_CATALOG_TEST_KEY = prev;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("legacyModelSection: 新形modelsから旧形modelセクションの形を合成する", () => {
  const dir = mktmp();
  const legacy = legacyModelSection({
    default: "prov/main",
    fallbacks: ["prov/sub"],
    providers: {
      prov: {
        id: "prov", baseUrl: "https://api.example/v4", api: "openai-completions",
        auth: { env: null }, // envを見ない
        params: { reasoningEffort: "low", webSearch: true },
        models: [{ id: "main", name: "Main", contextWindow: 123000, maxTokens: 3000 }, { id: "sub" }],
      },
    },
  }, [dir]);
  assert.equal(legacy.baseUrl, "https://api.example/v4");
  assert.equal(legacy.model, "main");
  assert.equal(legacy.maxTokens, 3000);
  assert.equal(legacy.contextWindow, 123000);
  assert.equal(legacy.reasoningEffort, "low");
  assert.equal(legacy.webSearch, true);
  assert.deepEqual(legacy.fallbackModels, ["sub"]);
  assert.equal(legacy.apiKey, null, "auth無しはnull");
  assert.equal(legacy.apiKeyEnv, null);
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig: 新形のみの設定でcfg.modelが既定プロバイダから合成される", () => {
  const dir = mktmp();
  const cfgPath = join(dir, "hive.config.json");
  writeFileSync(cfgPath, JSON.stringify({
    models: {
      default: "zai/glm-5.3-flash",
      providers: {
        zai: {
          baseUrl: "https://api.example/v4", api: "openai-completions",
          params: { maxTokens: 4000 },
          models: [{ id: "glm-5.3-flash", contextWindow: 200000, maxTokens: 4000 }],
        },
      },
    },
  }));
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dir;
  try {
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.models.default, "zai/glm-5.3-flash");
    assert.equal(cfg.model.baseUrl, "https://api.example/v4");
    assert.equal(cfg.model.model, "glm-5.3-flash");
    assert.equal(cfg.model.maxTokens, 4000);
    assert.equal(cfg.model.apiKey, null);
    assert.equal(cfg.model.apiKeyEnv, null, "auth.env未指定はenvを見ない(null)");
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: 旧形modelセクションはdefaultプロバイダに読み替えられる", () => {
  const dir = mktmp();
  const cfgPath = join(dir, "hive.config.json");
  writeFileSync(cfgPath, JSON.stringify({
    model: { baseUrl: "https://old.example/v1", apiKeyEnv: "HIVE_OLD_KEY", model: "glm-5.3-flash", fallbackModels: ["m2"], maxTokens: 4000 },
  }));
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dir;
  try {
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.models.default, "default/glm-5.3-flash");
    assert.deepEqual(cfg.models.fallbacks, ["default/m2"]);
    assert.equal(cfg.models.providers.default.baseUrl, "https://old.example/v1");
    assert.equal(cfg.models.providers.default.auth.env, "HIVE_OLD_KEY");
    assert.equal(cfg.model.model, "glm-5.3-flash", "旧形のcfg.modelはそのまま");
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
