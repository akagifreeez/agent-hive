// 一時パッチ: mcp.jsへ子プロセスerror(ENOENT等)ハンドリングを追加(#27)
// 教訓に従いテンプレートリテラル・バックスラッシュ埋め込みは使わない(行配列+join)
import { readFileSync, writeFileSync } from "node:fs";

const p = "src/engine/mcp.js";
const src = readFileSync(p, "utf8");

// 現状の改行コードを保持
const eol = src.includes("\r\n") ? "\r\n" : "\n";

const anchor = "    this.pending = new Map(); // id => {resolve, reject, timer}";
if (!src.includes(anchor)) {
  console.error("ANCHOR NOT FOUND: pending map");
  process.exit(1);
}

// (1) コンストラクタ: deadフラグとchildError保持を追加
const ctorLines = [
  "    this.pending = new Map(); // id => {resolve, reject, timer}",
  "    this.buf = \"\";",
  "    /** @type {string | null} 起動失敗(子のerrorイベント)の記録。失敗後のrequestは即座に拒否する */",
  "    this.childError = null;",
];
const ctorOld = [
  "    this.pending = new Map(); // id => {resolve, reject, timer}",
  "    this.buf = \"\";",
].join(eol);
if (!src.includes(ctorOld)) {
  console.error("ANCHOR NOT FOUND: ctor block");
  process.exit(1);
}

// (2) exitハンドラの後にerrorハンドラを足す(errorはexitと共存する)
const exitAnchor = "      this.pending.clear();\n    });";
const exitOld = [
  "      this.pending.clear();",
  "    });",
].join(eol);
if (!src.includes(exitOld)) {
  console.error("ANCHOR NOT FOUND: exit handler");
  process.exit(1);
}
const exitNew = [
  "      this.pending.clear();",
  "    });",
  "    // #27: 起動コマンドが存在しない等の子プロセスの非同期error(ENOENT等)。ここを捕まえないと",
  "    // Unhandled 'error' event でhiveプロセス全体が落ちる。起動失敗してもhiveは続行する(契約)。",
  "    // pending要求は全てok:false系のrejectへ回し、以後のrequestも即座に失敗させる(不整合防止)。",
  "    this.child.on(\"error\", (err) => {",
  "      this.childError = err.message;",
  "      this.bus?.emit(\"mcp.failed\", { name: this.name, error: err.message });",
  "      for (const p of this.pending.values()) {",
  "        clearTimeout(p.timer);",
  "        p.reject(new Error(\"MCPサーバー \" + this.name + \" の起動に失敗: \" + err.message));",
  "      }",
  "      this.pending.clear();",
  "    });",
  "    // stdinへの書き込みもEPIPEで投げることがある(error伝播を止めるだけが目的)",
  "    this.child.stdin?.on?.(\"error\", () => {});",
].join(eol);

let out = src;
out = out.replace(ctorOld, ctorLines.join(eol));
if (out === src) { console.error("CTOR REPLACE FAILED"); process.exit(1); }
const afterCtor = out;
out = out.replace(exitOld, exitNew);
if (out === afterCtor) { console.error("EXIT REPLACE FAILED"); process.exit(1); }

// (3) request: deadな場合は即座にreject(start()のタイムアウト待ちを避ける)
const reqAnchor = [
  "      this.pending.set(id, { resolve, reject, timer });",
  "      this.child.stdin.write(msg);",
].join(eol);
if (!out.includes(reqAnchor)) { console.error("ANCHOR NOT FOUND: request write"); process.exit(1); }
const reqNew = [
  "      this.pending.set(id, { resolve, reject, timer });",
  "      // #27: 起動失敗済みの子への書き込みは無意味。タイムアウトまで待たせず即失敗させる",
  "      if (this.childError) {",
  "        this.pending.delete(id);",
  "        clearTimeout(timer);",
  "        reject(new Error(\"MCPサーバー \" + this.name + \" は起動失敗済み: \" + this.childError));",
  "        return;",
  "      }",
  "      this.child.stdin.write(msg);",
].join(eol);
out = out.replace(reqAnchor, reqNew);

writeFileSync(p, out);
console.log("PATCHED OK");
