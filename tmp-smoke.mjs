import { readFileSync } from "node:fs";
const html = readFileSync("src/ui/public/index.html", "utf8");
function extract(name) {
  const i = html.indexOf("function " + name + "(");
  if (i < 0) throw new Error(name + " not found");
  let depth = 0, started = false, end = -1;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    if (c === "}") { depth--; if (started && depth === 0) { end = j + 1; break; } }
  }
  return html.slice(i, end);
}
const src = extract("usageAggTable") + "\n" + extract("renderStatusTab");
function el(tag) {
  const e = {
    tag, children: [], style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild(c) { e.children.push(c); return c; },
    append(...cs) { for (const c of cs) e.children.push(c); },
    querySelectorAll() { return []; },
    onclick: null, _ih: "", _tc: "",
  };
  Object.defineProperty(e, "className", { get: () => e._cn ?? "", set: (v) => { e._cn = v; } });
  Object.defineProperty(e, "id", { get: () => e._id ?? "", set: (v) => { e._id = v; } });
  Object.defineProperty(e, "textContent", { get: () => e._tc, set: (v) => { e._tc = String(v); } });
  Object.defineProperty(e, "innerHTML", { get: () => e._ih, set: (v) => { e._ih = String(v); e.children = []; } });
  return e;
}
const aggData = {
  byDate: [{ date: "2026-09-29", calls: 3, promptTokens: 100, completionTokens: 50, reasoningTokens: 10, costUsd: 0.0123 }],
  byThread: [
    { thread: "issue-cost", calls: 2, promptTokens: 80, completionTokens: 40, reasoningTokens: 8, costUsd: 0.01, agentIds: ["a1"] },
    { thread: "__main__", calls: 1, promptTokens: 20, completionTokens: 10, reasoningTokens: 2, costUsd: 0.0023, agentIds: ["lead"] },
  ],
  matrix: [{ date: "2026-09-29", thread: "__main__", calls: 1, promptTokens: 20, completionTokens: 10, reasoningTokens: 2, costUsd: 0.0023 }],
};
globalThis.document = { createElement: (t) => el(t), querySelectorAll: () => [], getElementById: () => null, body: el("body") };
globalThis.hfetch = async () => ({ json: async () => ({ usage: "[]", aggregate: aggData }) });
globalThis.escapeHtml = (s) => String(s);
globalThis.statusJa = (s) => String(s ?? "");
globalThis.NAMES = {};
const state = { live: { agents: {} } };
const fn = new Function("body", "lastState", "ctxTab", src + "\n" + 'return renderStatusTab(body);');
const body = el("div");
fn.call(globalThis, body, state, "status");
await new Promise((r) => setTimeout(r, 20));
const aggBox = body.children.find((c) => c.id === "usage-aggregate");
if (!aggBox) { console.error("FAIL: usage-aggregate box not found"); process.exit(1); }
const texts = [];
const walk = (n) => { texts.push(n.textContent); for (const c of n.children ?? []) walk(c); };
walk(aggBox);
const joined = texts.join("\n");
const checks = [
  ["日別見出し", "消費(日別・直近14日)"],
  ["スレッド別見出し", "消費(スレッド別・直近14日)"],
  ["マトリクス見出し", "消費(日別×スレッド)"],
  ["日別行", "2026-09-29"],
  ["スレッド別メイン変換", "メイン"],
  ["スレッド別行", "issue-cost"],
  ["コスト書式", "$0.0123"],
  ["合計行", "合計"],
];
let ok = true;
for (const [label, needle] of checks) {
  const hit = joined.includes(needle);
  console.log((hit ? "OK  " : "FAIL") + " " + label + " :: " + needle);
  if (!hit) ok = false;
}
globalThis.hfetch = async () => ({ json: async () => ({ usage: "[]", aggregate: { byDate: [], byThread: [], matrix: [] } }) });
const body2 = el("div");
fn.call(globalThis, body2, state, "status");
await new Promise((r) => setTimeout(r, 20));
const box2 = body2.children.find((c) => c.id === "usage-aggregate");
const t2 = [];
const walk2 = (n) => { t2.push(n.textContent); for (const c of n.children ?? []) walk2(c); };
walk2(box2);
const emptyHit = (t2.join("\n").match(/usageはまだありません。/g) ?? []).length;
console.log((emptyHit >= 3 ? "OK  " : "FAIL") + " 空データ時のhint表示 x" + emptyHit);
if (emptyHit < 3) ok = false;
console.log(ok ? "SMOKE ALL GREEN" : "SMOKE FAILED");
process.exit(ok ? 0 : 1);
