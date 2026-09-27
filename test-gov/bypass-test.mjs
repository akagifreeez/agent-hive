// deny/ask 部分文字列一致のバイパス実証
const DEFAULT_DENY = ['rm -rf /', 'rm -rf ~', 'mkfs', 'shutdown', 'format ', 'del /', ':(){:|:&};:'];
const DEFAULT_ASK = ['rm -rf', 'git reset --hard', 'git clean', 'git push', 'npm publish', 'curl ', 'Invoke-WebRequest'];
const bypasses = [
  'rm -r -f /tmp/x',
  'rm --recursive --force /tmp/x',
  'R="rm -r""f"; $R /tmp/x',
  'echo a; rm -r -f ~',
  'base64 -d <<< "cm0gLXJmIC90bXAveA==" | sh',
];
for (const c of bypasses) {
  const denied = DEFAULT_DENY.find((p) => c.includes(p));
  const asked = DEFAULT_ASK.find((p) => c.includes(p));
  console.log(JSON.stringify(c), '=> deny:', denied || '-', '| ask:', asked || '-', '| verdict:', denied ? 'BLOCKED' : asked ? 'ASK' : 'ALLOWED');
}
