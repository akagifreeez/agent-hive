import fs from "node:fs";
const p = "src/engine/browser-tools.js";
let s = fs.readFileSync(p, "utf8");
const NL = s.includes("\r\n") ? "\r\n" : "\n";
const lines = s.split(NL);
// 1) リンク: ページ内リンク(#...)はhref:nullで一覧に残す(テスト仕様)。
const idx = lines.findIndex((l) => l.includes("const href = normalizeUrl(raw, base);"));
if (idx < 0) { console.error("anchor1 not found"); process.exit(1); }
if (!/if \(href === null\) continue;/.test(lines[idx + 1] ?? "")) {
  console.error("anchor2 not found:", JSON.stringify(lines[idx + 1]));
  process.exit(1);
}
lines[idx + 1] = "    if (href === null) { if (/^#/i.test(raw)) { links.push({ text, href: null }); } continue; }";
// 2) btFormFields: HTML出現順に直す(宣言順 input→select→textarea から変更)。
const fIdx = lines.findIndex((l) => l.startsWith("function btFormFields("));
if (fIdx < 0) { console.error("anchor3 not found"); process.exit(1); }
const endIdx = lines.findIndex((l, i) => i > fIdx && l === "}");
if (endIdx < 0) { console.error("anchor4 not found"); process.exit(1); }
const R = [];
R.push("function btFormFields(formInner) {");
R.push("  const src = String(formInner ?? \"\");");
R.push("  const fields = [];");
R.push("  const pushField = (f) => { if (f.name && fields.length < 100) fields.push(f); };");
R.push("  const tokenRe = /<(input|select|textarea)(" + "[^>]*)(?:>(" + "[\s\S]*?)<\/" + "(?:input|select|textarea)\s*>|\s*\/?>)/gi;");
R.push("  let m;");
R.push("  while ((m = tokenRe.exec(src))) {");
R.push("    const tag = String(m[1]).toLowerCase();");
R.push("    const attrs = m[2] ?? \"\";");
R.push("    const type = (btAttr(attrs, \"type\") || (tag === \"input\" ? \"text\" : tag)).toLowerCase();");
R.push("    if (type === \"submit\" || type === \"button\" || type === \"image\") continue;");
R.push("    if (tag === \"select\") {");
R.push("      const options = [];");
R.push("      const optRe = /<option\s([^>]*)>([\s\S]*?)<\/option\s*>/gi;");
R.push("      let om;");
R.push("      let value = \"\";");
R.push("      while ((om = optRe.exec(m[3] ?? \"\"))) {");
R.push("        const oa = om[1] ?? \"\";");
R.push("        const val = btAttr(oa, \"value\") ?? btStripTags(om[2]);");
R.push("        const selected = /(^|\s)selected(\s|$|=)/i.test(oa);");
R.push("        if (!value || selected) value = val;");
R.push("        options.push(val);");
R.push("      }");
R.push("      pushField({ name: btAttr(attrs, \"name\") ?? \"\", type: \"select\", value, options, order: fields.length + 1 });");
R.push("    } else if (tag === \"textarea\") {");
R.push("      pushField({ name: btAttr(attrs, \"name\") ?? \"\", type: \"textarea\", value: btDecodeEntities(m[3] ?? \"\"), order: fields.length + 1 });");
R.push("    } else {");
R.push("      pushField({ name: btAttr(attrs, \"name\") ?? \"\", type, value: btAttr(attrs, \"value\") ?? \"\", order: fields.length + 1 });");
R.push("    }");
R.push("  }");
R.push("  return fields;");
R.push("}");
lines.splice(fIdx, endIdx - fIdx + 1, ...R);
fs.writeFileSync(p, lines.join(NL));
console.log("patched");
