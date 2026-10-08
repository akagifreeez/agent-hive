// パッチ2: factory.js — modelStateInfo へ routing状態の公開を追加(/api/models経由でUIへ)
import { readFileSync, writeFileSync } from "node:fs";

const p = "src/model/factory.js";
let src = readFileSync(p, "utf8");
if (src.includes("\r\n")) src = src.split("\r\n").join("\n");

function mustReplace(oldText, newText, label) {
  if (!src.includes(oldText)) {
    console.error("PATCH2 FAIL: 見つかりません: " + label);
    process.exit(1);
  }
  src = src.replace(oldText, newText);
}

// --- (A) import に normalizeRoutingConfig を追加 ---
mustReplace(
  'import { RouterModel } from "./router.js";',
  'import { RouterModel } from "./router.js";\nimport { normalizeRoutingConfig } from "./router-config.js";',
  "import normalizeRoutingConfig",
);

// --- (B) modelStateInfo の戻り値へ routing を追加(fallbacks行の後) ---
mustReplace(
  '      ready: modelReady,\n      fallbacks: catalog.fallbackRefs,',
  '      ready: modelReady,\n      fallbacks: catalog.fallbackRefs,\n      // モデルルーティングの実効状態(実行中config)。UIスイッチの初期表示に使う\n'
  + '      routing: normalizeRoutingConfig(catalog.routing),',
  "modelStateInfo routing",
);

// --- (C) catch側の戻り値にも routing を足す(形を揃える。UIがundefinedで落ちらないよう) ---
mustReplace(
  '    return { name: config.model?.model ?? "(未設定)", ref: null, fallbacks: [], providers: [], error: err.message };',
  '    return { name: config.model?.model ?? "(未設定)", ref: null, fallbacks: [], providers: [], routing: null, error: err.message };',
  "catch側 routing",
);

writeFileSync(p, src, "utf8");
console.log("PATCH2 OK: factory.js へ routing公開を追加");
