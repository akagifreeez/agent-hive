import fs from "fs";
const p = "test/long-run-resilience.test.js";
let src = fs.readFileSync(p, "utf8");
const bs = String.fromCharCode(92);
// CHILD_SRCの相対import "../src/engine/crash-guard.js" はtmpdirから解決できずERR_MODULE_NOT_FOUND。
// 絶対fileURLを埋め込む形へ: テンプレートリテラルを動的文字列連結に置き換える
const oldHead = [
  'const CHILD_SRC = `',
  'import { installCrashGuard } from "../src/engine/crash-guard.js";',
  'const g = installCrashGuard({ logFile: process.argv[2] });',
].join(String.fromCharCode(10));
const newHead = [
  '// 子はtmpdir配下で動くため相対importでは解決できない(fileURLで絶対参照にする)',
  'const guardUrl = pathToFileURL(join(process.cwd(), "src", "engine", "crash-guard.js")).href;',
  'const CHILD_SRC = [',
  '  `import { installCrashGuard } from "${bs}${bs}${guardUrl}${bs}${bs}";`' + String.fromCharCode(44),
  '  `const g = installCrashGuard({ logFile: process.argv[2] });`',
].join(String.fromCharCode(10));
if (!src.includes(oldHead)) { console.error("head not found"); process.exit(1); }
src = src.replace(oldHead, newHead);
// テンプレートリテラルの残りを配列要素へ変換(末尾のバッククォート閉じを]へ)
const oldTail = [
  'setTimeout(() => {',
  '  try { process.stdout.write("ALIVE " + g.guardCount() + "' + bs + bs + 'n"); } catch {}',
  '}, 80);',
  '// 自然終了させる(ハンドルは無い)',
  '`;',
].join(String.fromCharCode(10));
const newTail = [
  '  `setTimeout(() => {`',
  '  `  try { process.stdout.write("ALIVE " + g.guardCount() + String.fromCharCode(10)); } catch {}`',
  '  `}, 80);`',
  '].join(String.fromCharCode(10));',
].join(String.fromCharCode(10));
if (!src.includes(oldTail)) { console.error("tail not found"); process.exit(1); }
src = src.replace(oldTail, newTail);
// 中間のコメント行/コード行はテンプレート内なので配列要素に変換する必要がある。
// 手間を避けるため、CHILD_SRC定義全体を一括で差し替える(正規表現で抽出)。
const m = src.match(/const CHILD_SRC = \[[\s\S]*?\]\.join\(String\.fromCharCode\(10\)\);/);
if (!m) { console.error("partial state"); process.exit(1); }
const replacement = [
  'const guardUrl = pathToFileURL(join(process.cwd(), "src", "engine", "crash-guard.js")).href;',
  'const CHILD_SRC = [',
  '  "import { installCrashGuard } from \\"" + guardUrl + "\\";",',
  '  "const g = installCrashGuard({ logFile: process.argv[2] });",',
  '  "// uncaughtRejection(undici terminatedを模したError)",',
  '  "Promise.reject(Object.assign(new TypeError(\\"terminated\\"), { code: undefined }));",',
  '  "// 非Error値のrejection(ガードは必ず文字列化してログへ残す)",',
  '  "setTimeout(() => { Promise.reject(\\"文字列rejection\\"); }, 20);",',
  '  "setTimeout(() => {",',
  '  "  try { process.stdout.write(\\"ALIVE \\" + g.guardCount() + String.fromCharCode(10)); } catch {}",',
  '  "}, 80);",',
  '].join(String.fromCharCode(10));',
].join(String.fromCharCode(10));
src = src.replace(m[0], replacement);
// pathToFileURLのimportを追加
if (!src.includes("pathToFileURL")) {
  src = src.replace('import { join } from "node:path";', 'import { join } from "node:path";' + String.fromCharCode(10) + 'import { pathToFileURL } from "node:url";');
}
fs.writeFileSync(p, src);
console.log("CHILD_SRC rewritten");
