// モニタ用SVGチャート描画(依存ゼロ・Vanilla JS)。
// GitHubイシュー#16: エージェント数/タスク進捗/トークン消費の推移をモニタページへ表示する。
// markdown.js と同じ構成: IIFEでwindow/globalThisへ公開し、Nodeのテストからも評価できる。
// XSS対策: 数値は toFixed で整形し、属性値は数値/既知の色リテラルのみ(ユーザー入力は入らない)。
(function () {
  var NS = "http://www.w3.org/2000/svg";
  var MAX_POINTS = 60; // 保持するサンプル数(3秒間隔なら約3分分)

  // チャートで使う色(固定リテラルのみ。外部入力は流さない)
  var COLORS = { agents: "#fbbf24", tasks: "#86efac", tokens: "#60a5fa" };

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /**
   * チャート描画に使う時系列をスナップショットから作る(純関数・テスト対象)。
   * @param {Array<{agents: number, open: number, claimed: number, done: number, tokens: number}>} history
   * @param {{width?: number, height?: number}} [opts]
   * @returns {{width: number, height: number, pad: number, series: Array<{key: string, label: string, color: string, points: Array<{x: number, y: number}>}>, yMax: number}}
   */
  function chartModel(history, opts) {
    var width = Number((opts ?? {}).width ?? 540);
    var height = Number((opts ?? {}).height ?? 120);
    var pad = { l: 34, r: 8, t: 8, b: 16 };
    var h = Array.isArray(history) ? history.slice(-MAX_POINTS) : [];
    if (h.length === 0) {
      h = [{ agents: 0, open: 0, claimed: 0, done: 0, tokens: 0 }];
    }
    // 各系列の値(タスク進捗は open/claimed/done の積み上げで合計=タスク総数)
    var vals = h.map(function (p) {
      return {
        agents: Math.max(0, Number(p.agents) || 0),
        tasks: Math.max(0, (Number(p.open) || 0) + (Number(p.claimed) || 0) + (Number(p.done) || 0)),
        tokens: Math.max(0, Number(p.tokens) || 0),
      };
    });
    var yMax = 0;
    for (var i = 0; i < vals.length; i++) {
      yMax = Math.max(yMax, vals[i].agents, vals[i].tasks);
    }
    if (yMax <= 0) yMax = 1; // 0除算・潰れ防止
    var iw = width - pad.l - pad.r;
    var ih = height - pad.t - pad.b;
    var stepX = vals.length > 1 ? iw / (vals.length - 1) : 0;
    var px = function (i) {
      return pad.l + stepX * i;
    };
    var py = function (v) {
      return pad.t + ih * (1 - clamp(v / yMax, 0, 1));
    };
    var defs = [
      { key: "agents", label: "エージェント数", color: COLORS.agents, get: function (v) { return v.agents; } },
      { key: "tasks", label: "タスク総数", color: COLORS.tasks, get: function (v) { return v.tasks; } },
    ];
    var series = defs.map(function (d) {
      return {
        key: d.key,
        label: d.label,
        color: d.color,
        points: vals.map(function (v, i) {
          return { x: Math.round(px(i) * 10) / 10, y: Math.round(py(d.get(v)) * 10) / 10 };
        }),
      };
    });
    return { width: width, height: height, pad: pad, series: series, yMax: yMax };
  }

  /**
   * 時系列からSVG文字列を作る(純関数・テスト対象)。外部ライブラリ不使用。
   * @param {Array<{agents: number, open: number, claimed: number, done: number, tokens: number}>} history
   * @param {{width?: number, height?: number, lastTokens?: number}} [opts]
   * @returns {string} SVG(マークアップ)
   */
  function renderChartSvg(history, opts) {
    var o = opts ?? {};
    var width = Number(o.width ?? 540);
    var height = Number(o.height ?? 120);
    var m = chartModel(history, { width: width, height: height });
    var ih = height - m.pad.t - m.pad.b;
    var out = [];
    out.push('<svg class="chart" width="' + m.width + '" height="' + m.height + '" viewBox="0 0 ' + m.width + " " + m.height + '" role="img" aria-label="推移チャート" xmlns="' + NS + '">');
    // 縦グリッド+Y軸ラベル(0/中間/最大)
    out.push('<line x1="' + m.pad.l + '" y1="' + m.pad.t + '" x2="' + m.pad.l + '" y2="' + (m.pad.t + ih) + '" stroke="#2c2c31"/>');
    var mid = Math.round((m.yMax / 2) * 10) / 10;
    var yMid = m.pad.t + ih / 2;
    out.push('<line x1="' + m.pad.l + '" y1="' + yMid + '" x2="' + (m.width - m.pad.r) + '" y2="' + yMid + '" stroke="#232327" stroke-dasharray="3 3"/>');
    out.push('<text x="2" y="' + (m.pad.t + 4) + '" fill="#6e6e73" font-size="9">' + esc(m.yMax) + "</text>");
    out.push('<text x="2" y="' + (yMid + 3) + '" fill="#6e6e73" font-size="9">' + esc(mid) + "</text>");
    out.push('<text x="2" y="' + (m.pad.t + ih) + '" fill="#6e6e73" font-size="9">0</text>');
    // 折れ線(エージェント数=黄・タスク総数=緑)
    for (var s = 0; s < m.series.length; s++) {
      var se = m.series[s];
      if (se.points.length === 1) {
        out.push('<circle cx="' + se.points[0].x + '" cy="' + se.points[0].y + '" r="2.5" fill="' + se.color + '"/>');
      } else {
        var pts = se.points.map(function (p) { return p.x + "," + p.y; }).join(" ");
        out.push('<polyline fill="none" stroke="' + se.color + '" stroke-width="1.6" points="' + pts + '"/>');
      }
    }
    // 凡例(最終値つき)
    var lastAgents = m.series[0].points.length ? history.slice(-MAX_POINTS).slice(-1)[0] : null;
    var la = lastAgents ? Math.max(0, Number(lastAgents.agents) || 0) : 0;
    var lt = m.series[1].points.length ? (Number(lastAgents?.open ?? 0) || 0) + (Number(lastAgents?.claimed ?? 0) || 0) + (Number(lastAgents?.done ?? 0) || 0) : 0;
    out.push('<text x="' + (m.width - 6) + '" y="' + (m.pad.t + 8) + '" text-anchor="end" font-size="10" fill="' + COLORS.agents + '">● エージェント ' + la + "</text>");
    out.push('<text x="' + (m.width - 6) + '" y="' + (m.pad.t + 21) + '" text-anchor="end" font-size="10" fill="' + COLORS.tasks + '">● タスク ' + lt + "</text>");
    out.push("</svg>");
    return out.join("");
  }

  /**
   * トークン消費の推移バー(横棒ミニチャート)。これもSVG文字列を返す(純関数)。
   * @param {Array<{tokens: number}>} history
   * @param {{width?: number, barHeight?: number}} [opts]
   * @returns {string}
   */
  function renderTokenBarsSvg(history, opts) {
    var width = Number((opts ?? {}).width ?? 540);
    var barH = Number((opts ?? {}).barHeight ?? 54);
    var padL = 34;
    var list = Array.isArray(history) ? history.slice(-MAX_POINTS) : [];
    var tokens = list.map(function (p) { return Math.max(0, Number(p.tokens) || 0); });
    var max = 0;
    for (var i = 0; i < tokens.length; i++) max = Math.max(max, tokens[i]);
    if (max <= 0) max = 1;
    var n = Math.max(tokens.length, 1);
    var slot = (width - padL - 8) / n;
    var bw = clamp(slot - 2, 1, 18);
    var out = [];
    out.push('<svg class="chart" width="' + width + '" height="' + barH + '" viewBox="0 0 ' + width + " " + barH + '" role="img" aria-label="トークン消費の推移" xmlns="' + NS + '">');
    var yMaxTxt = max >= 1000 ? Math.round(max / 1000) + "k" : String(Math.round(max));
    out.push('<text x="2" y="10" fill="#6e6e73" font-size="9">' + esc(yMaxTxt) + "</text>");
    out.push('<text x="2" y="' + (barH - 2) + '" fill="#6e6e73" font-size="9">0</text>');
    for (var j = 0; j < tokens.length; j++) {
      var hVal = Math.max(tokens[j] > 0 ? 2 : 0, (barH - 14) * (tokens[j] / max));
      var x = padL + slot * j + (slot - bw) / 2;
      var y = barH - 4 - hVal;
      out.push('<rect x="' + (Math.round(x * 10) / 10) + '" y="' + (Math.round(y * 10) / 10) + '" width="' + (Math.round(bw * 10) / 10) + '" height="' + (Math.round(hVal * 10) / 10) + '" fill="' + COLORS.tokens + '"/>');
    }
    if (tokens.length === 0) {
      out.push('<text x="' + padL + '" y="20" fill="#6e6e73" font-size="10">データなし</text>');
    }
    out.push("</svg>");
    return out.join("");
  }

  /**
   * スナップショットから履歴サンプルへ変換(純関数)。
   * @param {{agents?: Array<{tokens?: number}>, tasks?: {open?: unknown[], claimed?: unknown[], doneCount?: number}}} snap
   * @returns {{agents: number, open: number, claimed: number, done: number, tokens: number}}
   */
  function sampleFromSnapshot(snap) {
    var s = snap ?? {};
    var agents = Array.isArray(s.agents) ? s.agents : [];
    var t = s.tasks ?? {};
    return {
      agents: agents.length,
      open: Array.isArray(t.open) ? t.open.length : 0,
      claimed: Array.isArray(t.claimed) ? t.claimed.length : 0,
      done: Number(t.doneCount) || 0,
      tokens: agents.reduce(function (acc, a) { return acc + (Number(a?.tokens) || 0); }, 0),
    };
  }

  /** 履歴バッファへサンプルを追加(最大MAX_POINTS件・破壊的に保持) */
  function pushSample(history, sample) {
    history.push(sampleFromSnapshot(sample));
    if (history.length > MAX_POINTS) history.splice(0, history.length - MAX_POINTS);
    return history;
  }

  var api = { chartModel: chartModel, renderChartSvg: renderChartSvg, renderTokenBarsSvg: renderTokenBarsSvg, sampleFromSnapshot: sampleFromSnapshot, pushSample: pushSample, MAX_POINTS: MAX_POINTS, COLORS: COLORS };
  if (typeof window !== "undefined") window.monitorChart = api;
  if (typeof globalThis !== "undefined") globalThis.monitorChart = api;
})();
