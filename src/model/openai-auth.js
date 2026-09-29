// OpenAI Codex OAuth(ChatGPT Plus/Proサブスク)の認証モジュール。
// PKCEフロー(auth.openai.com)+localhostコールバック受信+トークン交換/リフレッシュ。
// トークンはJSONファイル(state/配下)に {providerId: {access, refresh, expires, accountId, email}} 形で保存。
// 依存ゼロ(node:crypto/node:http/node:fs)。仕様はOpenClaw(@openclaw/ai)の実装と同一:
// client_idはCodex CLI公式のもの、accountIdはaccess token(JWT)の
// クレーム"https://api.openai.com/auth".chatgpt_account_idから抽出する。
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // Codex CLI公式クライアント
export const OPENAI_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_SCOPE = "openid profile email offline_access";
// OpenClawの1455と衝突しないようhiveは14546。auth.openai.com側の許可がポート任意の
// loopback前提のため。塞がっている場合は代替ポートで起動する
export const CALLBACK_PORT_CANDIDATES = [14546, 14547, 14548];
const CALLBACK_PATH = "/auth/callback";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

// ===== PKCEとフロー =====

export function createPKCE() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** 認証URLを組み立てる(ユーザーのブラウザで開く)。 */
export function buildAuthorizeUrl({ verifier, state, redirectUri, originator = "codex_cli" }) {
  const url = new URL(OPENAI_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OPENAI_SCOPE);
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return url.toString();
}

/** コールバックサーバを立てる(listen成功まで待ってから返す)。
 * 戻りのpromiseは?codeの受信で解決する(state不一致・error応答・タイムアウトはreject)。
 * ポートが塞がっている場合はエラーになるため、呼び出し側が候補を順に試す。
 * @returns {Promise<{promise: Promise<{code: string}>, close: Function}>} */
export function openCallbackServer({ redirectUri, state, timeoutMs = 5 * 60_000 }) {
  const url = new URL(redirectUri);
  const port = Number(url.port);
  const path = url.pathname;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((res, rej) => {
    resolvePromise = res;
    rejectPromise = rej;
  });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    const err = u.searchParams.get("error");
    if (err) {
      html(res, `認証が拒否されました(${err})`);
      cleanup();
      rejectPromise(new Error(`認証が拒否されました: ${err}`));
      return;
    }
    const code = u.searchParams.get("code");
    const gotState = u.searchParams.get("state");
    if (!code || gotState !== state) {
      html(res, "state不一致です。もう一度最初から認証してください");
      cleanup();
      rejectPromise(new Error("コールバックのstateが不一致です(もう一度認証してください)"));
      return;
    }
    html(res, "認証が完了しました。このページを閉じてhiveへ戻ってください");
    cleanup();
    resolvePromise({ code });
  });
  const timer = setTimeout(() => {
    cleanup();
    rejectPromise(new Error("認証コールバックがタイムアウトしました(5分以内にブラウザでログインを完了してください)"));
  }, timeoutMs);
  function html(res, message) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<html><body style="font-family:sans-serif"><h3>${message}</h3></body></html>`);
  }
  function cleanup() {
    clearTimeout(timer);
    try { server.close(); } catch { /* 既に閉じている */ }
  }
  return new Promise((openResolve, openReject) => {
    server.once("error", (err) => {
      cleanup();
      openReject(new Error(`コールバックポート${port}を確保できません: ${err.message}`));
    });
    server.listen(port, "127.0.0.1", () => openResolve({ promise, close: cleanup }));
  });
}

// ===== トークン交換とリフレッシュ =====

async function postTokenForm(body, timeoutMs = 30_000) {
  const res = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  let text = "";
  try {
    text = await res.text();
    json = JSON.parse(text);
  } catch { /* 非JSON応答(文言として使う) */ }
  if (!res.ok || !json?.access_token) {
    throw new Error(classifyTokenError(res.status, json, text));
  }
  return json;
}

/** エラーを理由分類する(OpenClawと同じコード群+再ログイン誘導)。 */
export function classifyTokenError(status, json, text = "") {
  const code = json?.error?.code ?? (typeof json?.error === "string" ? json.error : undefined);
  const reasons = {
    invalid_grant: "認証コードが無効または使用済みです",
    invalid_refresh_token: "リフレッシュトークンが無効です",
    refresh_token_expired: "リフレッシュトークンの有効期限が切れました",
    refresh_token_invalidated: "リフレッシュトークンが失効(無効化)されました",
    refresh_token_reused: "リフレッシュトークンが再利用検知で無効化されました",
  };
  const reason = reasons[code];
  const short = String(json?.error_description ?? json?.error?.message ?? text).slice(0, 200);
  if (reason) return `${reason}(コード: ${code})。もう一度認証してください`;
  if (status === 401 || status === 403) return `認証が拒否されました(${status})。もう一度認証してください`;
  return `トークン交換が失敗しました(HTTP ${status}): ${short}`;
}

/** 認証コードをトークンへ交換する。
 * @returns {Promise<{access: string, refresh: string, expires: number}>} */
export async function exchangeCode(code, verifier, redirectUri) {
  const json = await postTokenForm({
    grant_type: "authorization_code",
    client_id: OPENAI_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + Number(json.expires_in ?? 0) * 1000,
  };
}

/** リフレッシュトークンからアクセストークンを更新する。
 * refresh_tokenが返らない応答では既存を保持する(OpenClawと同じ)。
 * @returns {Promise<{access: string, refresh: string, expires: number}>} */
export async function refreshToken(refreshTokenValue) {
  const json = await postTokenForm({
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    client_id: OPENAI_CLIENT_ID,
  });
  return {
    access: json.access_token,
    refresh: json.refresh_token || refreshTokenValue,
    expires: Date.now() + Number(json.expires_in ?? 0) * 1000,
  };
}

// ===== JWT accountId =====

/** access token(JWT)からChatGPTアカウントIDを抽出する。 */
export function extractAccountId(accessToken) {
  const parts = String(accessToken ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const id = payload?.[OPENAI_AUTH_CLAIM]?.chatgpt_account_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/** access token(JWT)からメールアドレスを抽出する(表示用)。 */
export function extractEmail(accessToken) {
  const parts = String(accessToken ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const email = payload?.email ?? payload?.[OPENAI_AUTH_CLAIM]?.user_email;
    return typeof email === "string" && email.includes("@") ? email : null;
  } catch {
    return null;
  }
}

// ===== トークンストア =====

/** トークンストア(JSON)を読む。無ければ空オブジェクト。
 * 形: {[providerId]: {access, refresh, expires, accountId, email, updatedAt}} */
export function readTokenStore(file, baseDirs = []) {
  for (const base of baseDirs) {
    const f = resolve(base, file);
    if (existsSync(f)) {
      try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; }
    }
  }
  return {};
}

/** トークンストアへ書き戻す。リフレッシュトークンを含むため0600(新規作成時のモード)+
 * 既存ファイルへのchmod(Linuxのumask 022で0644になるのを防ぐ。Windowsではmode無視=無害)。 */
export function writeTokenStore(file, store, baseDirs = []) {
  const target = resolve(baseDirs[baseDirs.length - 1] ?? process.cwd(), file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(store, null, 1), { mode: 0o600 });
  try { chmodSync(target, 0o600); } catch { /* Windowsでは不要 */ }
}

/** 有効なaccess tokenを取得する(期限切れならリフレッシュして保存し直す)。
 * @param {{provider: string, file: string}} storeRef
 * @param {string[]} baseDirs
 * @param {{forceRefresh?: boolean}} [opts]
 * @returns {Promise<{access: string, accountId: string|null}>} */
export async function resolveOAuthToken(storeRef, baseDirs, opts = {}) {
  const store = readTokenStore(storeRef.file, baseDirs);
  const entry = store[storeRef.provider];
  if (!entry?.refresh) return null; // 未認証
  const expiresSoon = !entry.expires || entry.expires < Date.now() + 5 * 60_000;
  if (!opts.forceRefresh && entry.access && !expiresSoon) {
    return { access: entry.access, accountId: entry.accountId ?? null };
  }
  const refreshed = await refreshToken(entry.refresh); // 失敗は理由つきの例外(上位で案内文にする)
  const next = {
    ...entry,
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
    accountId: extractAccountId(refreshed.access) ?? entry.accountId ?? null,
    email: extractEmail(refreshed.access) ?? entry.email ?? null,
    updatedAt: Date.now(),
  };
  store[storeRef.provider] = next;
  writeTokenStore(storeRef.file, store, baseDirs);
  return { access: next.access, accountId: next.accountId ?? null };
}

/** 認証済みかどうかの同期判定(UI表示用。access/refreshの有無のみ見る)。 */
export function hasOAuthEntry(storeRef, baseDirs = []) {
  const entry = readTokenStore(storeRef.file, baseDirs)[storeRef.provider];
  return Boolean(entry?.refresh);
}

/** 認証済みの表示ヒント(email優先・無ければaccountId末尾・無ければ"設定済み")。 */
export function oauthHint(storeRef, baseDirs = []) {
  const entry = readTokenStore(storeRef.file, baseDirs)[storeRef.provider];
  if (!entry?.refresh) return null;
  if (entry.email) return entry.email;
  if (entry.accountId) return "…" + String(entry.accountId).slice(-6);
  return "設定済み";
}
