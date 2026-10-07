import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTap } from "../src/engine/test-triage.js";
import { startDiscovery } from "../src/engine/discover.js";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
const NL = String.fromCharCode(10);
const src = readFileSync("test/test-triage.test.js", "utf8");
const m = src.match(/const REAL_SUMMARY_TAIL = \[([\s\S]*?)\]\.join\(NL\);/);
const arrSrc = m[1].replace(/BS \+/g, JSON.stringify(String.fromCharCode(92)) + " + ").replace(/NL/g, JSON.stringify(NL));
const FIXTURE = eval("[" + arrSrc + "]").join(NL);
function makeProbeAwareExec(fixtures) {
  return async (o) => {
    const c = String(o.command ?? "");
    if (c.includes("--name-status")) return { ok: true, text: "exit=0" + NL };
    if (c.startsWith("node --test")) return { ok: true, text: "exit=0" + NL + "# pass 1" + NL };
    return fixtures.triage ?? { ok: true, text: "exit=0" + NL };
  };
}
const ws = mkdtempSync(join(tmpdir(), "hive-dbg3-"));
const bus = new Bus();
const tasks = new TaskBlackboard(ws, bus);
const created = [];
bus.on("discovery.created", ({ taskId }) => created.push(taskId));
bus.on("discovery.skip", (e) => console.log("SKIP:", e.reason));
bus.on("discovery.error", (e) => console.log("ERROR:", e.error));
const full = parseTap("exit=1" + NL + FIXTURE);
const known = full.failures.filter((f) => f.name.includes("ガード")).map((f) => ({ file: f.file, name: f.name, area: "crash-guard" }));
console.log("known:", known.length);
const d = startDiscovery({ workspace: ws, tasks, bus, intervalSec: 3600, probes: { triage: { mode: "on", knownFailures: known } }, exec: makeProbeAwareExec({ triage: { ok: false, text: "exit=1" + NL + FIXTURE } }) });
await d.tick();
console.log("created:", created);
d.stop();
rmSync(ws, { recursive: true, force: true });
