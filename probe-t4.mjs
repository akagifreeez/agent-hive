// T4(上限2)直後の状態をそのままT8相当に持ち込む再現
import { runCommand } from "./src/engine/exec.js";
import { resetTestSemaphore, setTestMaxConcurrent, setSemaphoreSelfBlockGuard, testSemaphoreState, runTestCommand } from "./src/engine/test-semaphore.js";
const state = () => JSON.stringify(testSemaphoreState());
async function withSem(max, fn) {
  resetTestSemaphore();
  setTestMaxConcurrent(max);
  try { await fn(); } finally { resetTestSemaphore(); setSemaphoreSelfBlockGuard(false); }
}
// T4再現
await withSem(2, async () => {
  const cmd = "node --test test/fixtures/empty.test.js test/fixtures/empty.test.js";
  const p1 = runCommand({ command: cmd + " && echo done-1", timeoutMs: 15000 });
  const p2 = runCommand({ command: cmd + " && echo done-2", timeoutMs: 15000 });
  await Promise.all([p1, p2]);
});
console.log("after T4:", state());
// T5 FIFO
await withSem(1, async () => {
  const cmd = "node --test test/fixtures/empty.test.js";
  const log = [];
  const mk = (name) => runCommand({ command: cmd + " && echo fin-" + name, timeoutMs: 15000 }).then((r) => { if (r.ok) log.push(name); });
  const p1 = mk("a"); await new Promise(r => setTimeout(r, 50));
  const p2 = mk("b"); const p3 = mk("c");
  await Promise.all([p1, p2, p3]);
});
console.log("after T5:", state());
// T6 失敗→後続
await withSem(1, async () => {
  const bad = await runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 200 });
  console.log("T6 bad ok(expect false):", bad.ok);
  const next = await runCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000 });
  console.log("T6 next ok:", next.ok);
});
console.log("after T6:", state());
// T7(ガード解除版リーク検証)をガードONのまま飛ばすのが実況と同じ
await withSem(1, async () => {
  // guardはtrueのまま(=withSemaphoreだけ呼ぶ)。実況: T7がガード解除に失敗?
  console.log("guard at T7:", setSemaphoreSelfBlockGuard, typeof setSemaphoreSelfBlockGuard);
});
