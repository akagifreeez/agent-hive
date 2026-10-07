export default function(command) {
  const c = String(command ?? "");
  if (/[;&|(]\s*npm\s+(run\s+)?test/.test(c) || /[;&|(]\s*node\s+--test/.test(c)) return true;
  return /[;&|(]\s*npm\s+(--\S+\s+)*--test(\s|$)/.test(c);
}
