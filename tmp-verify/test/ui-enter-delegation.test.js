// saytextのEnter結線はdocumentレベルの委譲で受ける(長寿命タブでsaytextノードが
// 張り替えられてもEnterが死なない対策。通常時の挙動は旧の直付けと同一)。
// 併せてIME確定Enter(isComposing)で誤送信しないガードも持つ。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "src/ui/public/index.html"), "utf8");

test("UI: saytextのEnterはdocument委譲で受ける(target判定+sendSay)", () => {
  assert.match(html, /document\.addEventListener\("keydown", \(e\) => \{[^}]*?t\.id === "saytext"[^}]*?sendSay\(\)/s);
});

test("UI: EnterでpreventDefaultする(Firefoxの既定活性化がダイアログのキャンセルを即クリックする対策)", () => {
  // 委譲ハンドラ内でpreventDefaultがsendSayの前にあること
  assert.match(html, /t\.id === "saytext" && e\.key === "Enter" && !e\.shiftKey && !e\.isComposing\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*sendSay\(\);/);
});

test("UI: IME確定のEnter(isComposing)では送信しない", () => {
  assert.match(html, /!e\.isComposing/);
});

test("UI: 旧のsaytext直付けkeydownは委譲へ置き換え済み(二重送信のないこと)", () => {
  const direct = html.match(/\$\("saytext"\)\.addEventListener\("keydown"/);
  assert.equal(direct, null, "saytext直付けのkeydownが残っている(委譲と二重送信になる)");
});
