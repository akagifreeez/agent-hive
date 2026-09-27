import { createTools } from "./src/engine/tools.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rt-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
fs.symlinkSync(outside, path.join(ws, "link"), "junction");
const bus = { emit() {}, on() {} };
const t = createTools({ agent: { id: "rt", displayName: "rt" }, workspace: ws, board: { post() {} }, tasks: { claim() { return null; }, snapshot() { return { open: [], claimed: [], done: [] }; } }, bus, gate: null });
const tries = [
  ["read_file", { path: "link/secret.txt" }],
  ["read_file", { path: "..\\..\\x" }],
  ["read_file", { path: outside }],
  ["read_file", { path: "link" }],
  ["write_file", { path: "link/evil.txt", content: "x" }],
  ["write_file", { path: "state/evil.json", content: "x" }],
  ["write_file", { path: "STATE/evil.json", content: "x" }],
  ["write_file", { path: "state/../evil.txt", content: "x" }],
];
for (const [name, args] of tries) {
  try { const r = await t.execute(name, args); console.log(name, JSON.stringify(args).slice(0, 60), "=>", r.ok ? "OK(要確認!)" : r.text.slice(0, 90)); }
  catch (e) { console.log(name, JSON.stringify(args).slice(0, 60), "=> THROWN:", e.message.slice(0, 90)); }
}
fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
process.exit(0);
