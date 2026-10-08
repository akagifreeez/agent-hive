// 文字列を指定幅へ中央寄せする。余りが奇数のときは左側を1文字少なくする。
export function padCenter(s, width) {
  const str = String(s ?? "");
  const w = Number(width) || 0;
  const total = w - [...str].length;
  if (total <= 0) return str;
  const right = Math.ceil(total / 2);
  const left = total - right;
  return " ".repeat(left) + str + " ".repeat(right);
}