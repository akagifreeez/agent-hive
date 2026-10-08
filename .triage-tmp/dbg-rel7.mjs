import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const ws = mkdtempSync(join(tmpdir(), "hive-rel7-"));
mkdirSync(join(ws, "tasks", "done"), { recursive: true });
mkdirSync(join(ws, "tasks", "claimed"), { recursive: true });
writeFileSync(join(ws, "tasks", "claimed", "a2--t6.md"), "b\n");
try {
  const { renameSync } = await import("node:fs");
  renameSync(join(ws, "tasks", "claimed", "a2--t6.md"), join(ws, "tasks", "done", "a2--t6.md"));
  console.log("OK; done:", readdirSync(join(ws, "tasks", "done")));
} catch (e) {
  console.log("ERR:", e.code, e.message.slice(0, 200));
}
rmSync(ws, { recursive: true, force: true });
