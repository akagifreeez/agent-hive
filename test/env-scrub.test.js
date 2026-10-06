// 子プロセスへの環境変数スクラブ(G5・dsh defensive-patterns移植):
// 鍵っぽい変数名(KEY/SECRET/TOKEN/PASSWORD/PASSWD/CREDENTIAL)は子プロセスへ渡さない。
// 明示割り当てenv(MCPサーバーの設定env等)は上書きで通る。GH_TOKEN/GITHUB_TOKENは既定で残す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubEnv, runCommand } from "../src/engine/exec.js";

function withEnv(names, fn) {
  const saved = names.map(([k]) => [k, process.env[k]]);
  for (const [k, v] of names) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("env-scrub: 鍵っぽい変数名は落ちる(ハーネスのトークンを子へ漏らさない)", () => {
  const out = scrubEnv({
    PATH: "/bin",
    SystemRoot: "C:\\Windows",
    HIVE_UI_TOKEN: "csrf-secret",
    MY_API_KEY: "k1",
    FOO_SECRET: "s1",
    FOO_PASSWORD: "p1",
    DB_PASSWD: "pw",
    SERVICE_CREDENTIAL: "c1",
  });
  assert.equal(out.PATH, "/bin");
  assert.equal(out.SystemRoot, "C:\\Windows");
  for (const k of ["HIVE_UI_TOKEN", "MY_API_KEY", "FOO_SECRET", "FOO_PASSWORD", "DB_PASSWD", "SERVICE_CREDENTIAL"]) {
    assert.equal(out[k], undefined, `${k} は子プロセスへ渡らない`);
  }
});

test("env-scrub: GH_TOKEN/GITHUB_TOKENはhiveの正規ワークフロー(gh)のために既定で残す", () => {
  const out = scrubEnv({ GH_TOKEN: "gh1", GITHUB_TOKEN: "gh2" });
  assert.equal(out.GH_TOKEN, "gh1");
  assert.equal(out.GITHUB_TOKEN, "gh2");
});

test("env-scrub: 明示割り当てenvはスクラブを上書きする(MCPサーバーの設定env等)", () => {
  const out = scrubEnv({ BASE_TOKEN: "ambient" }, { MCP_KEY: "configured" });
  assert.equal(out.MCP_KEY, "configured", "extraは狙いの割り当てなのでそのまま通る");
  assert.equal(out.BASE_TOKEN, undefined);
});

test("env-scrub: HIVE_ENV_ALLOWで既定の許可一覧へ追加できる", async () => {
  await withEnv([["HIVE_ENV_ALLOW", "MY_SPECIAL_TOKEN"]], () => {
    const out = scrubEnv({ MY_SPECIAL_TOKEN: "t1", OTHER_TOKEN: "t2" });
    assert.equal(out.MY_SPECIAL_TOKEN, "t1");
    assert.equal(out.OTHER_TOKEN, undefined);
  });
});

test("env-scrub: runCommandでもスクラブが効く(子プロセスから鍵が見えない)", async () => {
  await withEnv([["HIVE_UI_TOKEN", "supersecret123"], ["HIVE_SCRUB_PROBE", "probe-ok"]], async () => {
    const r = await runCommand({
      command: 'node -e "process.stdout.write((process.env.HIVE_UI_TOKEN??\'-\')+\'|\'+(process.env.HIVE_SCRUB_PROBE??\'-\'))"',
      timeoutMs: 20000,
    });
    assert.equal(r.ok, true, r.text);
    assert.ok(!r.text.includes("supersecret123"), `鍵が漏れている: ${r.text}`);
    assert.ok(r.text.includes("probe-ok"), `鍵以外の変数は通る: ${r.text}`);
  });
});

test("env-scrub: runCommandの明示envは従来どおり子プロセスへ届く", async () => {
  const r = await runCommand({
    command: 'node -e "process.stdout.write(process.env.HIVE_SCRUB_EXPLICIT??\'-\')"',
    env: { HIVE_SCRUB_EXPLICIT: "explicit-ok" },
    timeoutMs: 20000,
  });
  assert.equal(r.ok, true, r.text);
  assert.ok(r.text.includes("explicit-ok"), r.text);
});
