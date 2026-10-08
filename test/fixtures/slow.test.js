import { test } from "node:test";
import assert from "node:assert";
// わざと時間のかかるテストフィクスチャ(exec-semaphoreのタイムアウト誘発用)。
// sleepは子プロセス終了を待たない直帰方式ではなく、実際に1.5秒消費する。
test("slow fixture(1.5秒)", async () => {
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(true);
});
