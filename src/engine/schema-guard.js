// 構造化出力のスキーマ強制(イシュー#9): ワークフローでJSONを扱うときの型保証。
// ZCode側運用のplaceholder検出ガード(仮値"test"/1文字値/欠損キーの検出+再走)相当を提供する。
//
// 使い方(ワークフロースクリプト内):
//   const data = await api.withGuard({
//     schema: { type: "object", required: ["name", "count"], properties: { name: { type: "string" }, count: { type: "integer" } } },
//     placeholder: { forbidStrings: ["test", "todo", "n/a", "tbd"], forbidSingleChar: true },
//     run: async (attempt) => fetchSomething(attempt),
//   });
//   // runの応答が不正なときは reasons を添えて再走(既定3回)。全滅時は最後のreasonsを添えて例外。

/** @typedef {{ type?: string, required?: string[], properties?: Record<string, SchemaLike>, items?: SchemaLike, enum?: unknown[] }} SchemaLike */
/** @typedef {{ ok: boolean, value?: unknown, reasons?: string[] }} GuardCheck */

const PLACEHOLDER_STRINGS = ["test", "todo", "tbd", "n/a", "na", "dummy", "placeholder", "xxx", "fixme"];
const MAX_DEPTH = 20;

/**
 * 軽量JSON Schema風バリデータ。対応: type(object/array/string/number/integer/boolean/null)、
 * required、properties、items、enum。未対応キーは無視(過剰制約にしない)。
 * @param {unknown} value
 * @param {SchemaLike|null|undefined} schema
 * @param {string} [path]
 * @returns {string[]} 違反の説明(空配列=OK)
 */
export function validateSchema(value, schema, path = "$") {
  if (!schema || typeof schema !== "object") return [];
  /** @type {string[]} */
  const reasons = [];
  const t = schema.type;
  if (t) {
    const ok = checkType(value, t);
    if (!ok) reasons.push(`${path}: 型が ${t} であるべき(実際は ${typeName(value)})`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    reasons.push(`${path}: 許可値(${schema.enum.map((v) => JSON.stringify(v)).join(", ")})のいずれでもない`);
  }
  if (t === "object" || (value && typeof value === "object" && !Array.isArray(value))) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const key of schema.required ?? []) {
        if (!(key in value)) reasons.push(`${path}.${key}: 必須キーが欠損`);
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (key in value) reasons.push(...validateSchema(value[key], sub, `${path}.${key}`));
      }
    }
  }
  if ((t === "array" || Array.isArray(value)) && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => reasons.push(...validateSchema(item, schema.items, `${path}[${i}]`)));
  }
  return reasons;
}

/**
 * @param {unknown} value
 * @param {string} t
 * @returns {boolean}
 */
function checkType(value, t) {
  switch (t) {
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true; // 未知の型名は制約しない
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * placeholder(仮値)検出。ZCode運用のガードに準拠:
 * - 文字列が仮値語("test"等)と一致(大文字小文字・前後空白を無視)
 * - forbidSingleChar指定時、1文字の文字列(手抜きの典型)
 * - オブジェクトの値・配列要素も再帰的に見る(欠損キーはvalidateSchemaのrequiredで検出)
 * @param {unknown} value
 * @param {{ forbidStrings?: string[], forbidSingleChar?: boolean }} [opts]
 * @param {string} [path]
 * @param {number} [depth]
 * @returns {string[]} 違反の説明(空配列=OK)
 */
export function findPlaceholders(value, opts = {}, path = "$", depth = 0) {
  const reasons = [];
  if (depth > MAX_DEPTH) return reasons;
  const forbid = opts.forbidStrings ?? PLACEHOLDER_STRINGS;
  const forbidSingleChar = opts.forbidSingleChar ?? true;
  if (typeof value === "string") {
    const norm = value.trim().toLowerCase();
    if (forbid.map((s) => s.toLowerCase()).includes(norm)) reasons.push(`${path}: 仮値っぽい文字列 "${value.slice(0, 40)}"`);
    else if (forbidSingleChar && norm.length === 1) reasons.push(`${path}: 1文字の値 "${value.slice(0, 40)}"(手抜き応答の疑い)`);
    return reasons;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => reasons.push(...findPlaceholders(item, opts, `${path}[${i}]`, depth + 1)));
    return reasons;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) reasons.push(...findPlaceholders(v, opts, `${path}.${k}`, depth + 1));
  }
  return reasons;
}

/**
 * LLM応答からJSONを抜き出してパースする。コードフェンス```json ... ```や前置き文を許容。
 * @param {string} text
 * @returns {{ ok: boolean, value?: unknown, reasons?: string[] }}
 */
export function parseJsonLoose(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, reasons: ["応答が空です"] };
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(trimmed);
  const first = trimmed.search(/[[{]/);
  if (first >= 0) candidates.push(trimmed.slice(first));
  const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (first >= 0 && lastBrace > first) candidates.push(trimmed.slice(first, lastBrace + 1));
  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch { /* 次の候補へ */ }
  }
  return { ok: false, reasons: ["応答からJSONをパースできませんでした"] };
}

/**
 * スキーマ+placeholder検証の統合。
 * @param {unknown} value パース済みの値
 * @param {{ schema?: SchemaLike|null, placeholder?: { forbidStrings?: string[], forbidSingleChar?: boolean }|null }} [opts]
 * @returns {GuardCheck}
 */
export function checkStructured(value, opts = {}) {
  const reasons = [...validateSchema(value, opts.schema ?? null), ...findPlaceholders(value, opts.placeholder ?? {})];
  return reasons.length ? { ok: false, reasons } : { ok: true, value };
}

/**
 * 再走付きガード: run(attempt)を呼び、応答テキストをparseJsonLoose→checkStructuredで検証。
 * 不正のときはreasonsを添えて再走(最大maxAttempts回)。全滅時は最後の検証結果を例外にする。
 * @param {Object} o
 * @param {() => Promise<string>} o.run 試行ごとに応答テキスト(=JSON文字列)を返す関数。引数はattempt(1始まり)
 * @param {SchemaLike|null} [o.schema]
 * @param {{ forbidStrings?: string[], forbidSingleChar?: boolean }} [o.placeholder]
 * @param {number} [o.maxAttempts] 既定3
 * @param {(text: string) => void} [o.log]
 * @returns {Promise<unknown>} 検証済みの値
 */
export async function guardJson({ run, schema = null, placeholder = null, maxAttempts = 3, log = () => {} }) {
  /** @type {string[]} */
  let lastReasons = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let text = "";
    try {
      text = await run(attempt);
    } catch (err) {
      log(`attempt ${attempt}: run自体が失敗(${err.message})`);
      lastReasons = [`run失敗: ${err.message}`];
      continue;
    }
    const parsed = parseJsonLoose(text);
    if (!parsed.ok) {
      lastReasons = parsed.reasons ?? ["パース失敗"];
      log(`attempt ${attempt}: ${lastReasons.join("; ")}`);
      continue;
    }
    const checked = checkStructured(parsed.value, { schema, placeholder });
    if (checked.ok) return checked.value;
    lastReasons = checked.reasons ?? [];
    log(`attempt ${attempt}: 検証NG → ${lastReasons.join("; ")}`);
  }
  throw new Error(`構造化出力ガード: ${maxAttempts}回全て不正でした。最後の違反: ${lastReasons.join("; ") || "(理由無し)"}`);
}
