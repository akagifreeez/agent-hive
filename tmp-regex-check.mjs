// 一時検証スクリプト(fix-merge-guard-false-positive-diag 用、用後削除)
// 狙い: 文字列から組み立てた正規表現で diff一覧(SHA..agent/beta): 形式がマッチするか確かめる
const input = 'diff一覧(e3eea05ab4abb225da47b31baefa49222b4ab7f6..agent/beta): exit=0, broken.js';
const BS = String.fromCharCode(92);
const pat = 'diff一覧' + BS + '(' + '([0-9a-f]{7,40})' + BS + '.' + BS + '.agent/beta' + BS + '):';
console.log('source:', new RegExp(pat).source);
console.log('match:', new RegExp(pat, 'u').test(input));
