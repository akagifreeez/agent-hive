import { readFileSync } from "node:fs";
import { parseTap, classifyFailures, deriveArea } from "../src/engine/test-triage.js";
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
// テストと同じフィクスチャを再構築(テストファイルから抽出)
const src = readFileSync("test/test-triage.test.js", "utf8");
const m = src.match(/const REAL_SUMMARY_TAIL = \[([\s\S]*?)\]\.join\(NL\);/);
if (!m) { console.log("fixture not found"); process.exit(1); }
const arrSrc = m[1].replace(/BS \+/g, JSON.stringify(String.fromCharCode(92)) + " + ").replace(/NL/g, JSON.stringify(NL));
const FIXTURE = eval("[" + arrSrc + "]").join(NL);
const r = parseTap("exit=1" + NL + FIXTURE);
console.log("failures:", r.failures.length);
for (const f of r.failures) console.log(" area=", deriveArea(f.file, f.name, f.errorType), "| name=", f.name.slice(0, 30));
