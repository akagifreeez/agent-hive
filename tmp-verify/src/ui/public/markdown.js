// ボード投稿用の小型マークダウン描画(依存ゼロ)。
// XSS対策: まずHTMLを全エスケープし、以降は自分が生成するタグしか挿入しない。
// 対応: フェンスコード/インラインコード/太字/斜め字/打消し/見出し/リスト/引用/表/リンク(http(s)のみ)/水平線
(function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function inline(text) {
    let t = escapeHtml(text);
    const codes = [];
    t = t.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    // 画像: /uploads/配下とdata:imageのみ許可(任意の外部URLはXSS/トラッキング避けで不許可)
    t = t.replace(/!\[([^\]]*)\]\((\/uploads\/[A-Za-z0-9._-]+|data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)\)/g, '<img src="$2" alt="$1" loading="lazy" class="md-img">');
    t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + codes[Number(i)] + "</code>");
    return t;
  }

  function renderMarkdown(src) {
    const lines = String(src).replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // フェンスコード
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // 閉じフェンス(無ければ最後まで)
        out.push('<pre><code>' + escapeHtml(buf.join("\n")) + "</code></pre>");
        continue;
      }
      // 見出し
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const lv = h[1].length;
        out.push("<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">");
        i++;
        continue;
      }
      // 水平線
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }
      // 引用
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + buf.map((b) => inline(b)).join("<br>") + "</blockquote>");
        continue;
      }
      // 表(現在行に|があり、次行がセパレータ)
      if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        const parseRow = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
        const header = parseRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(parseRow(lines[i]));
          i++;
        }
        out.push(
          "<table><thead><tr>" + header.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>",
        );
        continue;
      }
      // リスト(インデント2文字で1階層)
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
          if (!m) break;
          items.push({ depth: Math.floor(m[1].replace(/\t/g, "  ").length / 2), ordered: /^\d/.test(m[2]), text: m[3] });
          i++;
        }
        let html = "";
        const stack = []; // {ordered, depth, liOpen}
        for (const it of items) {
          while (stack.length && stack[stack.length - 1].depth > it.depth) {
            const s = stack.pop();
            html += (s.liOpen ? "</li>" : "") + "</" + (s.ordered ? "ol" : "ul") + ">";
          }
          if (!stack.length || stack[stack.length - 1].depth < it.depth) {
            // 深い階層: 親liの中に子リストを内包させる(liはまだ閉じない)
            stack.push({ ordered: it.ordered, depth: it.depth, liOpen: false });
            html += it.ordered ? "<ol>" : "<ul>";
          } else if (stack[stack.length - 1].liOpen) {
            html += "</li>";
            stack[stack.length - 1].liOpen = false;
          }
          html += "<li>" + inline(it.text);
          stack[stack.length - 1].liOpen = true;
        }
        while (stack.length) {
          const s = stack.pop();
          html += (s.liOpen ? "</li>" : "") + "</" + (s.ordered ? "ol" : "ul") + ">";
        }
        out.push(html);
        continue;
      }
      // 空行
      if (!line.trim()) {
        out.push("");
        i++;
        continue;
      }
      // 段落(構造行が出るまで連結)
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,4}\s|```|\s*([-*+]|\d+\.)\s|>|\|)/.test(lines[i]) &&
        !/^\s*(-{3,}|\*{3,})\s*$/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push("<p>" + buf.map((b) => inline(b)).join("<br>") + "</p>");
    }
    return out.join("\n");
  }

  if (typeof window !== "undefined") window.renderMarkdown = renderMarkdown;
  if (typeof globalThis !== "undefined") globalThis.renderMarkdown = renderMarkdown;
})();
