// index.jsのローカルimportリンク検査: マージ混線で「名前付きエクスポートが存在しない」
// 状態がmainに入ると起動即死する(2026-10-07実例: applyTestMaxConcurrent/applyTestSemaphoreConfig
// の名前混線)。index.jsは起動ファイルなのでテストからimportできず、npm testでは誰も拾わない。
// この検査がnpm testの時点で捕捉する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("index-imports: index.jsのローカルimportは実在する名前付きエクスポートである", async () => {
  const src = readFileSync(join(root, "src", "index.js"), "utf8");
  const re = /import\s*\{([^}]+)\}\s*from\s*"(\.[^"]+)";/g;
  let m;
  let checks = 0;
  while ((m = re.exec(src)) !== null) {
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const mod = await import(pathToFileURL(join(root, "src", m[2])).href);
    for (const n of names) {
      assert.notEqual(
        mod[n], undefined,
        `src/index.js の import { ${n} } from "${m[2]}" が存在しない(マージ混線の疑い・起動即死になる)`,
      );
      checks += 1;
    }
  }
  assert.ok(checks >= 10, `index.jsのローカルimportを拾えている(検査済み${checks}件)`);
});

function pathToFileURL(p) {
  return "file:///" + p.replace(/\\/g, "/");
}
