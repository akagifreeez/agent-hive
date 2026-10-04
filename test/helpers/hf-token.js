// テスト用: startUiで立てたサーバーからCSRFトークンを取得し、以後のglobal fetchの
// POSTに X-Hive-Token を自動付与する。悪意あるオリジン403テストはオリジンヘッダが
// 先に判定されるため影響しない(トークン判定より前)。
let active = null;

export function tokenedFetchOn() {
  const realFetch = globalThis.fetch;
  if (realFetch.__tokened) return; // 二重適用防止
  const wrapped = async (input, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    if (method !== "POST" || !active) return realFetch(input, init);
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("x-hive-token")) headers.set("x-hive-token", active);
    return realFetch(input, { ...init, headers });
  };
  wrapped.__tokened = true;
  globalThis.fetch = wrapped;
}

// startUiヘルパー: UIを立ててトークンを吸い出してactiveにする。
// 戻り値の ui.token も入れておく(子プロセスCLIテストが HIVE_UI_TOKEN として渡す)
export async function startUiTokenized(startUi, args) {
  const ui = await startUi(args);
  const html = await (await fetch(`http://127.0.0.1:${args.config.ui.port}/`)).text();
  const m = html.match(/window\.HIVE_TOKEN = ("[^"]*")/);
  active = m ? JSON.parse(m[1]) : "";
  return Object.assign(ui, { token: active });
}

export function _setActiveToken(t) { active = t; }
