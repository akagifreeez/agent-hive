// 修復2: パッチ適用時の取りこぼしを直す(2026-10-07 gamma)
// (a) task-id-uniqueness.test.js: 旧テスト末尾の残骸行(rmTree/});)を削除
// (b) openai.js: 誤って置換した isRetryableNetworkError を復元(自分の追加ヘルパーの直前に戻す)
import { readFileSync, writeFileSync } from "node:fs";

function load(path) {
  const raw = readFileSync(path, "utf8");
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  return { raw, nl, lines: raw.split(nl) };
}
function save(path, nl, lines) {
  writeFileSync(path, lines.join(nl));
}

// (a) 残骸行削除: 新ブロックの終端 "});" の直後に "  rmTree(ws);" + "});" が続く箇所を1箇所だけ削除
{
  const { nl, lines } = load("test/task-id-uniqueness.test.js");
  let removed = 0;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const n1 = lines[i + 1] ?? "";
    const n2 = lines[i + 2] ?? "";
    if (
      removed === 0 &&
      l.trim() === "});" &&
      l.trim() === "});" &&
      n1.trim() === "rmTree(ws);" &&
      n2.trim() === "});" &&
      (lines[i - 1] ?? "").includes("openへ再起票される")
    ) {
      // l(新ブロックの終端)を残し、n1/n2(残骸)を飛ばす
      out.push(l);
      i += 2;
      removed++;
      continue;
    }
    out.push(l);
  }
  if (removed !== 1) throw new Error("残骸行が見つかりません removed=" + removed);
  save("test/task-id-uniqueness.test.js", nl, out);
  console.log("fixed: task-id-uniqueness.test.js 残骸削除");
}

// (b) isRetryableNetworkError の復元: 自分のコメント行(先頭が "// stream系の汎用Error")の直前に挿入
{
  const { nl, lines } = load("src/model/openai.js");
  const idx = lines.findIndex((l) => l.includes("// stream系の汎用Error"));
  if (idx < 0) throw new Error("挿入点が見つかりません");
  const restore = [
    "function isRetryableNetworkError(err) {",
    "  if (!err) return false;",
    '  const code = String(err.code ?? err.cause?.code ?? "");',
    "  return ABORT_CODE_RE.test(code) || isAbortRelated(err);",
    "}",
  ];
  lines.splice(idx, 0, ...restore.map((s) => s.replace(/\n/g, nl)));
  save("src/model/openai.js", nl, lines);
  console.log("fixed: openai.js isRetryableNetworkError 復元");
}
console.log("done");
