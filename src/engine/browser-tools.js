// 内蔵ブラウザ操作の解析系(依存ゼロ・node:urlのみ)。イシュー#10。
// レンダリング(JS実行・スクリーンショット)はスコープ外。その用途はMCP(Playwright等)で拡張する。
import { URL, URLSearchParams } from "node:url";

/** 相対URLをbaseと結合。断片のみ・javascript:/data:等はnull(誤遷移防止)。 */
export function normalizeUrl(href, baseUrl) {
  const h = String(href ?? "").trim();
  if (!h) return null;
  if (/^#/i.test(h) || /^javascript:/i.test(h) || /^data:/i.test(h) || /^vbscript:/i.test(h)) return null;
  try {
    return new URL(h, baseUrl).toString();
  } catch {
    return null;
  }
}

/** エンティティ逆変換(繰り返し展開は5回で打ち切り)。 */
const BT_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: String.fromCharCode(34), apos: String.fromCharCode(39), nbsp: " " };
function btDecodeEntities(s) {
  let out = String(s ?? "");
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, g) => {
      if (g.charAt(0) === "#") {
        const code = g.charAt(1) === "x" || g.charAt(1) === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return BT_ENTITIES[g.toLowerCase()] ?? m;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** タグ除去+空白整形。 */
function btStripTags(html) {
  return btDecodeEntities(String(html ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** 属性値を取り出す(name="v" / name='v' / name=v の3形態)。 */
function btAttr(attrs, name) {
  const mm = String(attrs ?? "").match(new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return mm ? String(mm[1] ?? mm[2] ?? mm[3] ?? "").trim() : null;
}

/** form内HTMLからフィールド(input/select/textarea)を抽出(submit系は除外)。 */
function btFormFields(formInner) {
  const fields = [];
  const pushField = (f) => { if (f.name && fields.length < 100) fields.push(f); };
  // input|select|textarea を1つの正規表現で出現順に走査する(HTML上の順序=order)
  const tagRe = /<(input|select|textarea)\s([^>]*?)(?:>([\s\S]*?)<\/\1\s*>|\/?>)/gi;
  let m;
  let order = 0;
  while ((m = tagRe.exec(formInner))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? "";
    const inner = m[3] ?? "";
    if (tag === "input") {
      const type = (btAttr(attrs, "type") || "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "image") continue;
      pushField({ name: btAttr(attrs, "name") ?? "", type, value: btAttr(attrs, "value") ?? "", order: ++order });
    } else if (tag === "select") {
      const options = [];
      const optRe = /<option\s([^>]*)>([\s\S]*?)<\/option\s*>/gi;
      let om;
      let value = "";
      while ((om = optRe.exec(inner))) {
        const oa = om[1] ?? "";
        const val = btAttr(oa, "value") ?? btStripTags(om[2]);
        const selected = /(^|\s)selected(\s|$|=)/i.test(oa);
        if (!value || selected) value = val;
        options.push(val);
      }
      pushField({ name: btAttr(attrs, "name") ?? "", type: "select", value, options, order: ++order });
    } else {
      pushField({ name: btAttr(attrs, "name") ?? "", type: "textarea", value: btDecodeEntities(inner), order: ++order });
    }
  }
  return fields;
}


/**
 * HTMLをページ情報へ構造化する。
 * @param {string} html 生HTML
 * @param {string} baseUrl 絶対URL(相対リンク解決の基準)
 * @returns {{url: string, title: string, headings: string[], links: Array<{text: string, href: string|null}>, forms: Array<{index: number, method: string, methodRaw?: string, action: string, html: string, fields: Array<{name: string, type: string, value: string, options?: string[], order: number}>}>, text: string, raw: string}}
 */
export function parsePage(html, baseUrl) {
  const src = String(html ?? "");
  const base = String(baseUrl ?? "");
  const tM = src.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = tM ? btStripTags(tM[1]) : "";
  const headings = [];
  const hRe = /<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1\s*>/gi;
  let hm;
  while ((hm = hRe.exec(src)) && headings.length < 50) {
    const t = btStripTags(hm[3]);
    if (t) headings.push(t);
  }
  const links = [];
  const aRe = /<a\s[^>]*?href=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let am;
  while ((am = aRe.exec(src)) && links.length < 100) {
    const raw = am[1] ?? am[2] ?? am[3] ?? "";
    const text = btStripTags(am[4]);
    const href = normalizeUrl(raw, base);
    if (href === null) continue; // javascript:/断片(#)等はリンク一覧から除外(テスト仕様: e80e512)
    if (!text) continue;
    links.push({ text, href });
  }
  const forms = [];
  const fRe = /<form\s([^>]*)>([\s\S]*?)<\/form\s*>/gi;
  let fm;
  while ((fm = fRe.exec(src))) {
    const attrs = fm[1] ?? "";
    const methodRaw = btAttr(attrs, "method") || "get";
    const actionRaw = btAttr(attrs, "action") || "";
    forms.push({
      index: forms.length + 1,
      method: methodRaw || "GET",
      methodRaw,
      action: normalizeUrl(actionRaw || base, base) ?? base,
      html: fm[2] ?? "",
      fields: btFormFields(fm[2] ?? ""),
    });
  }
  const bodyHtml = src.replace(/<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, " ");
  let textLines = btDecodeEntities(bodyHtml.replace(/<[^>]*>/g, "\n")).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (textLines.length > 200) textLines = textLines.slice(0, 200);
  return { url: base, title, headings, links, forms, text: textLines.join("\n"), raw: src };
}

/**
 * ページから要素一覧を抽出する(種別フィルタ可)。indexは1始まりの通し番号。
 * @param {ReturnType<typeof parsePage>} page
 * @param {{type?: "link"|"form"|"heading"}} [filter]
 */
export function extractElements(page, filter = {}) {
  const out = [];
  const want = filter.type ? [String(filter.type)] : ["link", "form", "heading"];
  let index = 0;
  for (const type of want) {
    if (type === "link") {
      // page.links(parsePage済み・断片/javascript除外済み)をそのまま列挙する
      for (const l of page.links ?? []) out.push({ index: ++index, type, text: l.text, href: l.href });
        } else if (type === "form") {
      for (const f of page.forms ?? []) out.push({ index: ++index, type, method: f.method, action: f.action, fields: f.fields.length });
    } else if (type === "heading") {
      const hRe = /<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1\s*>/gi;
      let hm;
      let count = 0;
      while ((hm = hRe.exec(String(page.raw ?? ""))) && count < 50) {
        const t = btStripTags(hm[3]);
        if (t) { out.push({ index: ++index, type, level: Number(hm[1]), text: t }); count++; }
      }
    }
  }
  return out;
}

/** セレクタ(タグ名・#id・.classの簡易対応)で部分テキスト抽出。未指定は全文。 */
export function extractText(page, selector) {
  if (!selector) return page.text;
  const src = String(page.raw ?? "");
  const sel = String(selector).trim();
  const idm = sel.match(/^#([\w-]+)$/);
  const clsm = sel.match(/^\.([\w-]+)$/);
  let re;
  if (idm) re = new RegExp("<([a-z][a-z0-9]*)\\s[^>]*?id\\s*=\\s*[\"']?" + idm[1] + "[\"']?[^>]*>([\\s\\S]*?)</\\1\\s*>", "i");
  else if (clsm) re = new RegExp("<([a-z][a-z0-9]*)\\s[^>]*?class\\s*=\\s*[\"'][^\"']*" + clsm[1] + "[^\"']*[\"'][^>]*>([\\s\\S]*?)</\\1\\s*>", "i");
  else re = new RegExp("<" + sel + "(\\s[^>]*)?>([\\s\\S]*?)</" + sel + "\\s*>", "i");
  const m = re.exec(src);
  if (!m) return "一致する要素がありません(セレクタ: " + sel + ")";
  return btStripTags(m[2]);
}

/**
 * HTML直からフォームを1つ取り出す(form_indexは1始まり・無指定は最初)。
 * @returns {{method: string, action: string, html: string, fields: Array<{name: string, type: string, value: string, order: number, options?: string[]}>} | null}
 */
export function extractForm(html, baseUrl, formIndex = null) {
  const page = parsePage(html, baseUrl);
  const idx = formIndex == null ? 1 : Number(formIndex);
  return (page.forms ?? []).find((f) => f.index === idx) ?? null;
}

/**
 * フォームへ値を反映(hidden温存・未指定は現値維持・checkboxはvalue属性・selectはoptions内のみ・新規キーは末尾追加)。非破壊。
 */
export function applyFormValues(form, values) {
  const v = values ?? {};
  const fields = (form.fields ?? []).map((f) => {
    if (!(f.name in v)) return { ...f };
    const given = v[f.name];
    if (f.type === "checkbox") return { ...f, value: given ? (f.value || "on") : "" };
    if (f.type === "select") {
      const opts = f.options ?? [];
      const str = String(given);
      return opts.includes(str) ? { ...f, value: str } : { ...f };
    }
    return { ...f, value: String(given) };
  });
  const known = new Set(fields.map((f) => f.name));
  for (const k of Object.keys(v)) {
    if (!known.has(k)) fields.push({ name: k, type: "text", value: String(v[k]), order: fields.length + 1 });
  }
  return { ...form, fields };
}

/**
 * 送信リクエストを組み立てる(GETはURL結合・POSTはurlenc)。
 * opts.selector指定時はフォームHTML内一致を検証し、無ければthrow(誤送信防止)。
 */
const BS = String.fromCharCode(92); // バックスラッシュ(正規表現を文字列連結で組むための定数)
const DQ = String.fromCharCode(34); // ダブルクォート
const SQ = String.fromCharCode(39); // シングルクォート
export function buildSubmission(form, values, opts = {}) {
  if (!form) throw new Error("フォームが見つかりません");
  const f = applyFormValues(form, values);
  if (opts.selector) {
    const sel = String(opts.selector).trim().toLowerCase();
    const esc = sel.replace(new RegExp("[.*+?^\${}()|[\]\\]", "g"), "\\$&");
    const inForm = new RegExp("<" + esc + "(\s|>)", "i").test(String(form.html ?? "")) || (form.fields ?? []).some((x) => x.name.toLowerCase() === sel);
    if (!inForm) throw new Error("フォーム内に要素 " + String(opts.selector) + " が見つかりません(誤送信防止のため送信しません)");
  }
  const pairs = f.fields.filter((x) => x.name).map((x) => [x.name, x.value ?? ""]);
  const body = new URLSearchParams(pairs).toString();
  if ((f.method || "GET").toUpperCase() === "GET") {
    const url = new URL(f.action);
    url.search = body ? "?" + body : url.search;
    return { method: "GET", url: url.toString(), body: null, headers: {} };
  }
  return { method: "POST", url: f.action, body, headers: { "content-type": "application/x-www-form-urlencoded" } };
}
