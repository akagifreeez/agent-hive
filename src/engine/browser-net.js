// 内蔵ブラウザ操作の通信系(依存ゼロ・node:http/httpsのみ)。イシュー#10。
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { parsePage, extractText, extractForm, buildSubmission, normalizeUrl } from "./browser-tools.js";

/** node:http(s)で1リクエスト。 */
function btRequest(method, url, { headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error("URLが不正です: " + url)); return; }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method, headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("timeout", () => { req.destroy(new Error("タイムアウト")); });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/** リダイレクト(301/302/303/307/308)を最大5回追従。 */
async function btFetchFollowing(method, url, opts = {}, redirects = 0) {
  const r = await btRequest(method, url, opts);
  const loc = r.headers ? (r.headers.location ?? null) : null;
  if ([301, 302, 303, 307, 308].includes(r.status) && loc && redirects < 5) {
    const next = normalizeUrl(Array.isArray(loc) ? loc[0] : loc, url);
    if (next) return btFetchFollowing("GET", next, {}, redirects + 1);
  }
  return r;
}

/** GETでページ取得→parsePage。ok/status/page/raw/text を返す(相対URLは拒否)。 */
export async function browserFetch(url) {
  const u = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(u)) {
    return { ok: false, text: "urlは http:// または https:// で始まる絶対URLを指定してください(指定: " + u + ")" };
  }
  try {
    const r = await btFetchFollowing("GET", u);
    const page = parsePage(r.body, u);
    return { ok: r.status >= 200 && r.status < 400, status: r.status, page, raw: r.body, text: page.text };
  } catch (err) {
    return { ok: false, text: "取得エラー: " + (err && err.message ? err.message : String(err)) };
  }
}

/** 取得→抽出を1呼び出しで。url指定時は取得、html指定時はそれを解析。 */
export async function browserExtract(args = {}) {
  const selector = args.selector ? String(args.selector) : null;
  let page;
  if (args.html != null) {
    page = parsePage(String(args.html), String(args.base_url ?? "http://127.0.0.1/"));
  } else {
    const r = await browserFetch(args.url);
    if (!r.ok) return { ok: false, text: r.text ?? "取得に失敗しました" };
    page = r.page;
  }
  const text = extractText(page, selector);
  return { ok: true, url: page.url, title: page.title, selector, text };
}

/**
 * フォーム送信。html+base_url からフォームを組立て、valuesを反映して送信する。
 * selector指定時はフォーム内一致を検証(無ければ送らない)。結果はテキストレポート+応答ページ解析。
 */
export async function browserSubmit(args = {}) {
  const html = String(args.html ?? "");
  const baseUrl = String(args.base_url ?? "");
  const values = args.values ?? {};
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, text: "base_urlは http:// または https:// で始まる絶対URLを指定してください" };
  }
  const formIndex = args.form_index == null ? null : Number(args.form_index);
  const form = extractForm(html, baseUrl, formIndex);
  if (!form) return { ok: false, text: "フォームが見つかりません(HTML内にform要素がありません)" };
  let sub;
  try {
    sub = buildSubmission(form, values, { selector: args.selector ? String(args.selector) : undefined });
  } catch (err) {
    return { ok: false, text: err && err.message ? err.message : String(err) };
  }
  const follow = args.follow_redirects === false ? 0 : 5;
  try {
    let r;
    if (sub.method === "GET") {
      r = await (follow ? btFetchFollowing("GET", sub.url, { headers: sub.headers }) : btRequest("GET", sub.url, { headers: sub.headers }));
    } else {
      const opts = { headers: sub.headers, body: sub.body };
      r = await (follow ? btFetchFollowing("POST", sub.url, opts) : btRequest("POST", sub.url, opts));
    }
    const resPage = parsePage(r.body, sub.url);
    const lines = [
      "送信: " + sub.method + " " + sub.url,
      "method: " + sub.method,
      "ステータス: " + r.status,
      "送信データ: " + (sub.body ?? "(なし)"),
      "",
      "=== 応答ページ ===",
      "タイトル: " + (resPage.title || "(なし)"),
      resPage.text,
    ];
    return { ok: r.status >= 200 && r.status < 400, status: r.status, request: { method: sub.method, url: sub.url, body: sub.body }, page: resPage, text: lines.join("\n") };
  } catch (err) {
    return { ok: false, text: "送信エラー: " + (err && err.message ? err.message : String(err)) };
  }
}
