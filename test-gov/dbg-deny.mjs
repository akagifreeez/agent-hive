// テスト失敗の原因特定: 'rm -rf /tmp/x' は deny パターン「rm -rf /」に部分文字列一致する
const c = 'rm -rf /tmp/x';
const D = ['rm -rf /', 'rm -rf ~', 'mkfs', 'shutdown', 'format ', 'del /', ':(){:|:&};:'];
console.log('deny hit:', D.find((p) => c.includes(p)) || '-');
// gate.check は deny なら即 allowed:false を返す → permission.request が出ない → pending 無し