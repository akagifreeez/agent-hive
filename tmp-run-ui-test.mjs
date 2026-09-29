// usage-aggregate UI描画のnode上スモーク: renderStatusTab相当を最小DOMで動かす
// (jsdom無し環境。DOM操作の必要部分だけスタブしてロジックを通す)
import { readFileSync } from "node:fs";

const html = readFileSync("src/ui/public/index.html", "utf8");
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error("script not found"); process.exit(1); }

function el(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    set className(v) { this._cn = v; }, get className() { return this._cn ?? ""; },
    set id(v) { this._id = v; }, get id() { return this._id ?? ""; },
    set textContent(v) { this._tc = String(v); }, get textContent() { return this._tc ?? ""; },
    set innerHTML(v) { this._ih = v; }, get innerHTML() { return this._ih ?? ""; },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { for (const c of cs) this.children.push(c); },
    querySelectorAll() { return []; },
    onclick: null,
  };
}
const aggData = {
  byDate: [{ date: "2026-09-29", calls: 3, promptTokens: 100, completionTokens: 50, reasoningTokens: 10, costUsd: 0.0123 }],
  byThread: [{ thread: "issue-cost", calls: 2, promptTokens: 80, completionTokens: 40, reasoningTokens: 8, costUsd: 0.01, agentIds: ["a1"] },
             { thread: "__main__", calls: 1, promptTokens: 20, completionTokens: 10, reasoningTokens: 2, costUsd: 0.0023, agentIds: ["lead"] }],
  matrix: [{ date: "2026-09-29", thread: "__main__", calls: 1, promptTokens: 20, completionTokens: 10, reasoningTokens: 2, costUsd: 0.0023 }],
};
globalThis.document = {
  createElement: (t) => el(t),
  querySelectorAll: () => [],
  getElementById: () => null,
  body: el("body"),
};
globalThis.hfetch = async () => ({ json: async () => ({ usage: "[]", aggregate: aggData }) });
globalThis.lastState = { live: { agents: {} } };
globalThis.escapeHtml = (s) => String(s);
globalThis.statusJa = (s) => String(s ?? "");
globalThis.NAMES = {};
globalThis.$ = () => null;

// renderStatusTabとusageAggTableだけを抜き出して実行
const fns = [];
for (const name of ["usageAggTable", "renderStatusTab"]) {
  const i = html.indexOf("function " + name + "(");
  if (i < 0) { console.error(name + " not found"); process.exit(1); }
  // 次の function かファイル末尾まで
  const rest = html.slice(i);
  const next = rest.slice(1).search(/\nfunction |\n\/\* =+/);
  fns.push(next < 0 ? rest : rest.slice(0, next + 1));
}
const body = el("div");
new Function(...fns, "lastState", "return renderStatusTab(lastState" + ")", fns.length === 2 ? "lastState" : "lastState");
console.log("constructed OK");
