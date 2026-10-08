// Skills(v1): workspace/skills/*.md を「ノウハウ文書」として扱う。
// システムプロンプトには索引(名前と概要)だけを載せ、本文は use_skill ツールで
// 必要になった時に読む(段階的開示)。ファイルはgit blackboardに乗るので共有もレビューも通常フロー。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function skillsDir(workspace) {
  return join(workspace, "skills");
}

export function listSkills(workspace) {
  const dir = skillsDir(workspace);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const raw = readFileSync(join(dir, f), "utf8");
      const lines = raw.split("\n");
      const desc = lines.find((l, i) => i > 0 && l.trim() && !l.trim().startsWith("#")) ?? "";
      return { name: f.replace(/\.md$/, ""), summary: desc.trim().slice(0, 100) };
    });
}

// システムプロンプトへ注入する索引ブロック。スキルが無ければ空文字。
export function buildSkillsIndex(workspace) {
  const skills = listSkills(workspace);
  if (!skills.length) return "";
  const rows = skills.map((s) => `- ${s.name}: ${s.summary || "(説明なし)"}`).join("\n");
  return `<available-skills>
[利用可能なスキル。該当する作業があるときは use_skill ツールで全文を読んでから着手してください。]
${rows}
</available-skills>`;
}

export function readSkill(workspace, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(name ?? ""))) return null;
  const f = join(skillsDir(workspace), `${name}.md`);
  if (!existsSync(f)) return null;
  return readFileSync(f, "utf8").slice(0, 8000);
}
