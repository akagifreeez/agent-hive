const block = String.fromCharCode(10) + "✖ chat(stream): stall検知でリトライし、2回目で成功する (97ms)" + String.fromCharCode(10) + "  Error: ストリームが途切れました(stall)";
const re1 = /^\s{0,4}([A-Za-z_$][\w$]*(?:Error|Exception))(?:\s*\[[A-Z_]+\])?:?\s*(.*)$/m;
console.log("re1:", re1.exec(block)?.slice(1, 3));
const re2 = /^\s{0,4}([A-Za-z_$][\w$]*(?:Error|Exception))(?:\s*\[[A-Z_]+\])?:?\s*(.*)$/m;
console.log("re2 src:", re2.source);
