// ModelRef("provider/model")の解析と整形。
// OpenClaw model-selectionのparseModelRefに相当する最小版: ベアモデルIDは
// 既定プロバイダで補完し、スラッシュ付きはそのまま使う。

/**
 * @param {string} ref "provider/model" またはベアのモデルID
 * @param {string|null} [defaultProvider] ベアIDのとき補完するプロバイダID
 * @returns {{provider: string, model: string}}
 */
export function parseModelRef(ref, defaultProvider = null) {
  if (typeof ref !== "string") throw new Error(`モデル参照が文字列ではありません: ${typeof ref}`);
  const s = ref.trim();
  if (!s) throw new Error("モデル参照が空です");
  const i = s.indexOf("/");
  if (i < 0) {
    if (!defaultProvider) throw new Error(`モデル"${s}"にプロバイダの指定がありません("provider/${s}"の形で指定してください)`);
    return { provider: defaultProvider, model: s };
  }
  const provider = s.slice(0, i);
  const model = s.slice(i + 1);
  if (!provider || !model) throw new Error(`モデル参照の形式が不正です: ${ref}("provider/model"の形で指定してください)`);
  return { provider, model };
}

/** @param {{provider: string, model: string}} ref @returns {string} */
export function formatModelRef(ref) {
  return `${ref.provider}/${ref.model}`;
}
