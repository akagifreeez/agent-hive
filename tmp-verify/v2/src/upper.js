// スペース/ハイフン/アンダースコア区切りの文字列を大文字スネークケース(UPPER_SNAKE)へ変換する。
// キャメルケースの大文字境界も区切りとして扱い、連続する区切りは1つに潰す。
export function toUpperSnake(s) {
  return String(s ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // キャメル境界をスペース化
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase())
    .join("_");
}