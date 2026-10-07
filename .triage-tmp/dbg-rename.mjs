import { mkdtempSync, rmSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const ws = mkdtempSync(join(tmpdir(), "hive-rn-"));
writeFileSync(join(ws, "a.md"), "x");
try {
  renameSync(join(ws, "a.md"), join(ws, "sub", "a.md"));
  console.log("rename to missing dir OK");
} catch (e) {
  console.log("rename ERR:", e.code, e.message.slice(0, 120));
}
rmSync(ws, { recursive: true, force: true });
