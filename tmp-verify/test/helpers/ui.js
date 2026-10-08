// startUiのテストヘルパー: CSRFトークンを取得してPOSTに自動付与するfetchを返す。
// 全POSTエンドポイントが X-Hive-Token を要求するようになったため、テストはこの
// tokenedFetch(または /api/state から取ったトークン)を使う。
export async function startUiWithToken(args) {
  const { startUi } = await import("../../src/ui/server.js");
  const ui = await startUi(args);
  const base = `http://127.0.0.1:${args.config.ui.port}`;
  let token = "";
  // トークンはHTMLに埋め込まれる( /*__HIVE_TOKEN__*/ の置換結果)。JSONから抜く
  const html = await (await fetch(base + "/")).text();
  const m = html.match(/window\.HIVE_TOKEN = (".*?");/);
  if (m) token = JSON.parse(m[1]);
  const post = async (path, body, headers = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hive-token": token, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
    });
  return { ui, base, token, post };
}
