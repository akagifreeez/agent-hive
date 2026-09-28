import { createTools } from "./src/engine/tools.js";
import { Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ws = mkdtempSync(join(tmpdir(), "rt-path-"));
const bus = new Bus();
const tasks = new TaskBlackboard(ws, bus);
const tools = createTools({ agent: { id: "rt", role: "impl" }, workspace: ws, mainWorkspace: ws, board: {}, tasks, bus });

const out = (label, r, extra = "") => console.log(label, "| ok:", r.ok, "|", r.text.slice(0, 90), extra ? "| " + extra : "");

// A-1: write_fileでstate/audit.jsonl
const a1 = await tools.execute("write_file", { path: "state/audit.jsonl", content: "evil" });
out("A-1 write state/audit.jsonl", a1);
// A-1b: edit_file
const a1b = await tools.execute("edit_file", { path: "state/audit.jsonl", old_text: "a", new_text: "b" });
out("A-1b edit state/audit.jsonl", a1b);

// A-2a: 相対パスの../脱出(read)
const a2a = await tools.execute("read_file", { path: "../hive.config.json" });
out("A-2a read ../hive.config.json", a2a, "(値は掲載しない)");
// A-2b: 絶対パス読み(存在しない鍵ファイル名で「読めた」判定だけ見る)
const a2b = await tools.execute("read_file", { path: "D:/working/_projects/agent-hive/hive.config.json" });
out("A-2b read absolute", a2b);
// A-2c: さらに上の階層
const a2c = await tools.execute("read_file", { path: "../../../windows/win.ini" });
out("A-2c read ../../../windows/win.ini", a2c);

// A-3: symlink脱出(symlink作成自体がWindowsではEPERMになりがち。試す)
const a3pre = await tools.execute("bash", { command: "cmd /c mklink linkdir ..\\_projects 2>&1 || echo mklink-failed" });
out("A-3a bash mklink", a3pre);
const a3 = await tools.execute("read_file", { path: "linkdir/agent-hive/hive.config.json" });
out("A-3b read via linkdir", a3);
