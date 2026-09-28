import { createTools } from "./src/engine/tools.js";
import { Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ws = mkdtempSync(join(tmpdir(), "rt-audit3-"));
const bus = new Bus();
const tasks = new TaskBlackboard(ws, bus);
const tools = createTools({ agent: { id: "rt", role: "impl" }, workspace: ws, mainWorkspace: ws, board: {}, tasks, bus });

// D-1: symlinkディレクトリでstate迂回
await tools.execute("bash", { command: "mkdir -p workdir" });
const r4 = await tools.execute("bash", { command: "ln -s state workdir/st; echo x >> workdir/st/evil.txt" });
console.log("D-1 symlink dir ok:", r4.ok, "| evil created:", existsSync(join(ws, "state", "evil.txt")));

// D-2: 引用分割でパス文字列を隠す(s''tate)
const r5 = await tools.execute("bash", { command: "echo x > s'tate/evil2.txt" });
console.log("D-2 quoted split ok:", r5.ok, "| evil2:", existsSync(join(ws, "state", "evil2.txt")));

// D-3: base64にしてstate語を隠す
const r6 = await tools.execute("bash", { command: "echo e3RhdGU= >/dev/null; echo dGVzdA== | base64 -d | xargs -I{} echo {} > /dev/null" });
console.log("D-3 base64 executed ok:", r6.ok);

// D-4: MCP経由でのコマンド実行(MCPツールは監査はされるが、ゲート(gate)を通らない)
// → 監査自体はwriteAuditがfinallyで走るので「記録漏れ」ではなく「ゲート迂回」の問題
// 候補: 監査記録はあるが PermissionGate を通らない
console.log("--- D-4 note: MCP tools bypass PermissionGate (gate.check) but still audited");

// D-5: bashを経由しないファイル書き込みで監査自体は残る(write_file等は通常監査される)
const r7 = await tools.execute("write_file", { path: "normal.txt", content: "ok" });
console.log("D-5 write normal ok:", r7.ok);
