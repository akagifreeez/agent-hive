// 検証ドライバ(ベータ): marker-guardテストを直接importして実行する(node --test経由はセマフォ待ちで詰まるため)
// 用が済んだら削除する。テスト自体は test/marker-guard.test.js(競合マーカーガード注入テスト2本)。
process.on("exit", (code) => {
  console.log("driver-exit-code=" + code);
});
await import("./test/marker-guard.test.js");
