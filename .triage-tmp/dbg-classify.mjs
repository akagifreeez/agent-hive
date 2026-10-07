const err = Object.assign(new TypeError("terminated"), { code: undefined });
const ABORT_CODE_RE = /^(UND_ERR|ECONNRESET|ECONNABORTED|EPIPE|ERR_STREAM_PREMATURE_CLOSE|ABORT_ERR|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED)/;
const ABORT_MSG_RE = /(^|)(terminated|aborted|socket hang up|other side closed|premature close|fetch failed|network error|connection (reset|closed|terminated)|request body (aborted|stream terminated))($|)/i;
const code = String(err.code ?? err.cause?.code ?? "");
console.log("code=[%s] codeTest=%s", code, ABORT_CODE_RE.test(code));
console.log("msgTest=%s", ABORT_MSG_RE.test("terminated"));
// node:testsで失敗するケースを再現 — テストは2回目のfetchが「2チャンク+null」
// つまり正常応答。retry中に calls===2 分岐へ入る。dbg2ではどうなった?
