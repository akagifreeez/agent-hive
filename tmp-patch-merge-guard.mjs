import { readFileSync, writeFileSync } from "node:fs";

// ---------- tools.js: openタスク依存は拒否(fail-fast、イシュー#25) ----------
const toolsPath = "src/engine/tools.js";
const tools = readFileSync(toolsPath, "utf8");
if (tools.includes("依存タスクが未完了")) {
  console.log("tools.js: dependency guard already present, skip");
} else {
  const anchor = '        const dependsOn = Array.isArray(args.depends_on) ? args.depends_on.map((s) => String(s ?? "").trim()).filter(Boolean) : [];';
  if (!tools.includes(anchor)) { console.error("tools.js anchor not found"); process.exit(1); }
  const guard = [
    '        // 依存タスクがopenのままなら起票を拒否(fail-fast。依存が全doneになるまで請求不可なのに起票すると永遠に請求できない幽霊タスクになる。イシュー#25)',
    '        if (dependsOn.length) {',
    '          const openDeps = tasks.list().open.filter((t) => dependsOn.includes(t.id));',
    '          if (openDeps.length > 0) return { ok: false, text: `依存タスクが未完了のため起票できません: ${openDeps.map((t) => t.id).join(", ")}。完了を待つか、depends_onを外して再起票してください。` };',
    '        }',
  ].join("\n");
  writeFileSync(toolsPath, tools.replace(anchor, anchor + "\n" + guard));
  console.log("tools.js patched");
}
