import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectShell, gitBashCandidates, runCommand } from "../src/engine/exec.js";

test("Git Bash: 標準・ユーザー別のインストール先をWSLより先に探す", () => {
  const candidates = gitBashCandidates({
    ProgramFiles: "C:/Program Files",
    LOCALAPPDATA: "C:/Users/test/AppData/Local",
    PATH: "",
  });
  assert.ok(candidates.includes(join("C:/Program Files", "Git", "bin", "bash.exe")));
  assert.ok(candidates.includes(join("C:/Users/test/AppData/Local", "Programs", "Git", "bin", "bash.exe")));
  assert.equal(candidates.includes("bash"), false);
});

test("runCommand: 検出したbashで空白入りパスとPOSIX構文を実行できる", async (t) => {
  if (await detectShell() !== "bash") return t.skip("bash is not installed");
  const workspace = mkdtempSync(join(tmpdir(), "hive shell spaces "));
  try {
    const result = await runCommand({
      command: "value='hello world'; printf '%s' \"$value\" > 'output file.txt'",
      cwd: workspace,
    });
    assert.equal(result.ok, true, result.text);
    assert.equal(readFileSync(join(workspace, "output file.txt"), "utf8"), "hello world");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
