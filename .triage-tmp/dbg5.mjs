import { readFileSync } from "node:fs";
import { parseTap } from "../src/engine/test-triage.js";
const NL = String.fromCharCode(10);
const src = readFileSync("test/test-triage.test.js", "utf8");
const m = src.match(/const REAL_SUMMARY_TAIL = \[([\s\S]*?)\]\.join\(NL\);/);
const arrSrc = m[1].replace(/BS \+/g, JSON.stringify(String.fromCharCode(92)) + " + ").replace(/NL/g, JSON.stringify(NL));
const FIXTURE = eval("[" + arrSrc + "]").join(NL);
const r = parseTap("exit=1" + NL + FIXTURE);
for (const f of r.failures) console.log(f.errorType.padEnd(16), "| msg=", JSON.stringify(f.message.slice(0, 40)));
