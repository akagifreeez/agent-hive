import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTap } from "../src/engine/test-triage.js";
import { startDiscovery } from "../src/engine/discover.js";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const FIXTURE = [
  "ℹ tests 603", "ℹ pass 588", "ℹ fail 8", "ℹ skipped 7",
  "✖ failing tests:", "",
  "test at test" + BS + "cli.test.js:103:1",
  "✖ CLI: cancel/release/reopen/auditが実サーバーに対して動く (1505ms)",
  "  AssertionError [ERR_ASSERTION]: Expected x",
].join(NL);
const ws = mkdtempSync(join(tmpdir(), "hive-dbg-"));
const bus = new Bus();
const tasks = new TaskBlackboard(ws, bus);
bus.on("discovery.error", (e) => console.log("DISCOVERY.ERROR:", e.error));
bus.on("discovery.skip", (e) => console.log("DISCOVERY.SKIP:", e.reason));
bus.on("discovery.created", (e) => console.log("CREATED:", e.taskId));
const fakeExec = async (o) => { console.log("EXEC keep=", o.keep, "cmd=", String(o.command).slice(0, 40)); return { ok: false, text: "exit=1" + NL + FIXTURE }; };
const d = startDiscovery({ workspace: ws, tasks, bus, intervalSec: 3600, probes: { triage: { mode: "on", knownFailures: [] } }, exec: fakeExec });
await d.tick();
console.log("open:", tasks.snapshot().open);
d.stop();
rmSync(ws, { recursive: true, force: true });
