// 一時パッチスクリプト(fix-merge-guard-false-positive-diag 用、用後削除)
// 狙い: test/marker-guard.test.js 55行目の診断assertを「 SHA..agent/beta ): 形式の存在確認」へ置換する。
// 経緯: diff一覧の値側に 'exit=0, ' ノイズ(merge-base取得時のstderr先頭行)が載る環境があり、
// 値まで固定一致させると環境差で落ちるため、鍵となる形式部分だけを検証する。
import fs from 'node:fs';
let s = fs.readFileSync('test/marker-guard.test.js', 'utf8');
const BS = String.fromCharCode(92);
const bad =
  '  assert.match(m.text, new RegExp("diff一覧' + BS + BS + '(' + BS + BS + 'd{7,40}' +
  BS + BS + '.' + BS + BS + '.agent/beta' + BS + BS + '):", "u"));';
const good =
  '  // 値側にstderr先頭行(exit=0等)が混入する環境があるため、形式部分(SHA..agent/beta): だけを見る\n' +
  '  assert.match(m.text, new RegExp("diff一覧' + BS + BS + '(' + BS + BS + 'd{7,40}' +
  BS + BS + '.' + BS + BS + '.agent/beta' + BS + BS + '):", "u"));' ;
if (!s.includes(bad)) { console.log('NO-MATCH'); process.exit(1); }
s = s.replace(bad, good);
fs.writeFileSync('test/marker-guard.test.js', s);
console.log('PATCHED');
