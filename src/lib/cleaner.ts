/**
 * Content cleaner v2 - preserves heading structure for AI
 *
 * Output modes:
 * 0. extractArticleBody() → extract article body HTML from full page
 * 1. cleanContent() → pure text (for display)
 * 2. cleanContentMarkdown() → Markdown with heading hierarchy (for AI)
 * 3. meaningfulTextLength() → 有意义文本字符数（去标签+去空白）
 */

/**
 * Extract the article body from a full page HTML.
 *
 * page_reader returns the ENTIRE page HTML (head, nav, footer, etc.).
 * This function isolates just the article content area using common
 * CSS class / tag patterns. Falls back to <body> or the full HTML.
 */
export function extractArticleBody(fullHtml: string): string {
  if (!fullHtml) return '';

  // Ordered by specificity — first match wins
  const bodyPatterns: Array<{ name: string; re: RegExp }> = [
    // ── canyin88 specific ──
    { name: 'content-editor', re: /class=["'][^"']*content-editor[^"']*["'][^>]*>([\s\S]+)$/i },
    { name: 'cd_content',     re: /class=["'][^"']*cd_content[^"']*["'][^>]*>([\s\S]+)$/i },
    // ── Common CMS patterns ──
    { name: 'article-content',  re: /class=["'][^"']*article-content[^"']*["'][^>]*>([\s\S]+)$/i },
    { name: 'post-content',     re: /class=["'][^"']*post-content[^"']*["'][^>]*>([\s\S]+)$/i },
    { name: 'post-body',        re: /class=["'][^"']*post-body[^"']*["'][^>]*>([\s\S]+)$/i },
    { name: 'article-body',     re: /class=["'][^"']*article-body[^"']*["'][^>]*>([\s\S]+)$/i },
    { name: 'entry-content',    re: /class=["'][^"']*entry-content[^"']*["'][^>]*>([\s\S]+)$/i },
    { name: 'news_content',     re: /class=["'][^"']*news_content[^"']*["'][^>]*>([\s\S]+)$/i },
    { name: 'win-news-content', re: /class=["'][^"']*win-news-content[^"']*["'][^>]*>([\s\S]+)$/i },
    { name: 'detail_content',   re: /class=["'][^"']*detail_content[^"']*["'][^>]*>([\s\S]+)$/i },
    { name: 'art_content',      re: /class=["'][^"']*art_content[^"']*["'][^>]*>([\s\S]+)$/i },
    { name: 'cont_text',        re: /class=["'][^"']*cont_text[^"']*["'][^>]*>([\s\S]+)$/i },
    // ── WeChat / winshang rich media content ──
    { name: 'rich_media_content', re: /class=["'][^"']*rich_media_content[^"']*["'][^>]*>([\s\S]+?)<\/div>\s*<!--/i },
    // ── Semantic HTML ──
    { name: '<article> tag',    re: /<article[^>]*>([\s\S]+?)<\/article>/i },
    // ── Generic class="content" inside a main/section (match content as a class token) ──
    // 原正则 `class=["']content["']` 只匹配 class 属性恰好等于 "content" 的元素，
    // 实际生产中绝大多数站点（如 linkshop.com 用 `class="container content clearfix"`）
    // 都会失败 → 落到 <body> fallback，cleaner 不做任何截断，所有站级 boilerplate
    // 全量进入 dedup 输入。修：用 \bcontent\b 作为词边界匹配，支持多类名。
    { name: 'class=content',    re: /class=["'][^"']*\bcontent\b[^"']*["'][^>]*>([\s\S]+)$/i },
  ];

  for (const { re } of bodyPatterns) {
    const match = fullHtml.match(re);
    if (match && match[1] && match[1].length > 200) {
      // We matched from the opening tag to end of string.
      // Now we need to find where the content div actually ends.
      // Strategy: strip trailing noise (footer, sidebar, scripts) rather than
      // trying to find the exact closing </div> (which is unreliable with regex).
      let body = match[1];

      // Remove everything after the last useful paragraph — cut at known noise markers
      const noiseMarkers = [
        /<div[^>]*class=["'][^"']*(?:comment|sidebar|related|recommend|share-box|reward|hot-list|column|footer-links|copyright|share|instructions|extra|module)[^"']*["']/i,
        /<section[^>]*class=["'][^"']*(?:comment|sidebar|related|recommend|extra|module|share)[^"']*["']/i,
        /<!--\s*(?:相关|推荐|评论|分享|打赏|版权|footer|可能会喜欢)/i,
      ];
      let cutIdx = body.length;
      for (const marker of noiseMarkers) {
        const m = body.match(marker);
        if (m && m.index && m.index < cutIdx && m.index > 100) {
          cutIdx = m.index;
        }
      }
      body = body.substring(0, cutIdx);

      if (body.length > 100) {
        return body;
      }
    }
  }

  // Fallback 1: extract <body> content
  const bodyTagMatch = fullHtml.match(/<body[^>]*>([\s\S]+?)<\/body>/i);
  if (bodyTagMatch && bodyTagMatch[1].length > 200) {
    return bodyTagMatch[1];
  }

  // Fallback 2: return everything after <body>
  const bodyStartMatch = fullHtml.match(/<body[^>]*>([\s\S]+)$/i);
  if (bodyStartMatch && bodyStartMatch[1].length > 200) {
    return bodyStartMatch[1];
  }

  // Last resort: return the full HTML
  return fullHtml;
}

const NOISE_PATTERNS = [
  /相关阅读[\s\S]*?(?=\n)/gi,
  /相关推荐[\s\S]*?(?=\n)/gi,
  /扫码关注[\s\S]*?(?=\n)/gi,
  /版权声明[\s\S]*?(?=\n)/gi,
  /关注公众号[\s\S]*?(?=\n)/gi,
  /长按识别[\s\S]*?(?=\n)/gi,
  /免责声明[\s\S]*?(?=\n)/gi,
  /本文来源[\s\S]*?(?=\n)/gi,
  /责任编辑[\s\S]*?(?=\n)/gi,
  /点击查看[\s\S]*?(?=\n)/gi,
  /分享到[\s\S]*?(?=\n)/gi,
  /点击阅读原文[\s\S]*?(?=\n)/gi,
  /更多精彩[\s\S]*?(?=\n)/gi,
  /微信扫一扫[\s\S]*?(?=\n)/gi,
  /举报[\s\S]*?(?=\n)/gi,
  /广告[\s\S]*?(?=\n)/gi,
  /写个文章不容易[\s\S]*?(?=\n)/gi,
  /查看更多[\s\S]*?(?=\n)/gi,
  /返回顶部[\s\S]*?(?=\n)/gi,
  /欢迎您的来电[\s\S]*?(?=\n)/gi,
  /拨打电话[\s\S]*?(?=\n)/gi,
  /添加微信[\s\S]*?(?=\n)/gi,
  /商务合作[\s\S]*?(?=\n)/gi,
  /联系电话[\s\S]*?(?=\n)/gi,
  /更多方式关注[\s\S]*?(?=\n)/gi,
  /粤ICP备[\s\S]*?(?=\n)/gi,
  /粤公网安备[\s\S]*?(?=\n)/gi,
  /版权所有[\s\S]*?(?=\n)/gi,
  /求打赏[\s\S]*?(?=\n)/gi,
  // ── Site-wide boilerplate (e.g. linkshop.com) ──
  // 这些块在所有站内文章中完全相同，跨文章 LCS 会凑出 500+ 字符
  // 共享，污染去重判定。下面几行在 text-cleaning 阶段是第二道防线，
  // 主防线在 extractArticleBody 的 class-based cut。
  /你可能会喜欢：?[\s\S]*?(?=\n)/gi,
  /\d+小时关注榜[\s\S]*?(?=\n)/gi,
  /发表评论[\s\S]*?(?=\n)/gi,
  /登录\s*[|｜]\s*注册[\s\S]*?(?=\n)/gi,
  /分享至：\s*\d*/gi,
  /本文为[\s\S]*?(?:转载|授权|所有|立场)[\s\S]*?(?=\n)/gi,
  /转载请联系[\s\S]*?(?=\n)/gi,
  /本站所有[\s\S]*?(?=\n)/gi,
];

const HTML_NOISE_PATTERNS = [
  /<script[\s\S]*?<\/script>/gi,
  /<style[\s\S]*?<\/style>/gi,
  /<nav[\s\S]*?<\/nav>/gi,
  /<footer[\s\S]*?<\/footer>/gi,
  /<aside[\s\S]*?<\/aside>/gi,
  /<header[\s\S]*?<\/header>/gi,
  // ── 站级 boilerplate 块（按 class 名剥整段，包括 <section> 和 <div>）──
  // linkshop.com 等站会在文章正文后面接整块「你可能会喜欢」「数据」
  // 「48小时关注榜」等 section，所有站内文章这些 section 跨文章完全相同。
  // 若不剥，dedup 的 LCS 会被 500+ 字符的跨文章完全相同内容污染。
  // 模式：class 含目标关键词 → 删到匹配的 </div> 或 </section> 边界
  /class=["'][^"']*\bextra\b[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section)>/gi,
  /class=["'][^"']*module[-_]?body[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section)>/gi,
  /class=["'][^"']*comment[-_]?(?:box|bar|list)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section)>/gi,
  /class=["'][^"']*share[-_]?box[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  /class=["'][^"']*instructions[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  /class=["'][^"']*share[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  /class=["'][^"']*comment[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  /class=["'][^"']*sidebar[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  /class=["'][^"']*related[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  /class=["'][^"']*recommend[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  /class=["'][^"']*reward[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  /class=["'][^"']*hot-list[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  /class=["'][^"']*column[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  /class=["'][^"']*search[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  /class=["'][^"']*breadcrumb[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
  /class=["'][^"']*pagination[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
];

/**
 * Remove HTML noise blocks from content
 */
function removeHtmlNoise(html: string): string {
  let content = html;
  for (const pattern of HTML_NOISE_PATTERNS) {
    content = content.replace(pattern, '');
  }
  return content;
}

/**
 * Clean content to pure text (for display)
 */
export function cleanContent(rawHtml: string): string {
  if (!rawHtml) return '';

  const content = removeHtmlNoise(rawHtml);

  let text = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Remove noise text patterns
  for (const pattern of NOISE_PATTERNS) {
    text = text.replace(pattern, '');
  }

  // Remove empty lines
  const lines = text.split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (!line) return false;
      if (/^https?:\/\/\S+$/.test(line)) return false;
      if (line.length < 4) return false;
      return true;
    });

  return lines.join('\n');
}

/**
 * Clean content to Markdown format (preserves heading hierarchy for AI)
 * h1 → ##, h2 → ##, h3 → ###, etc.
 */
export function cleanContentMarkdown(rawHtml: string): string {
  if (!rawHtml) return '';

  const content = removeHtmlNoise(rawHtml);

  // Convert headings to Markdown before stripping tags
  // h1/h2 → ##, h3 → ###, h4 → ####, etc.
  let text = content
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n## ${t.replace(/<[^>]*>/g, '').trim()}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n## ${t.replace(/<[^>]*>/g, '').trim()}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n### ${t.replace(/<[^>]*>/g, '').trim()}\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, t) => `\n#### ${t.replace(/<[^>]*>/g, '').trim()}\n`)
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, t) => `\n##### ${t.replace(/<[^>]*>/g, '').trim()}\n`)
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, t) => `\n###### ${t.replace(/<[^>]*>/g, '').trim()}\n`);

  // Convert other HTML elements
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => {
      return t.split('\n').map((l: string) => `> ${l.trim()}`).join('\n');
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Remove noise text patterns
  for (const pattern of NOISE_PATTERNS) {
    text = text.replace(pattern, '');
  }

  // Remove empty lines but preserve heading spacing
  const lines = text.split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (!line) return false;
      if (/^https?:\/\/\S+$/.test(line)) return false;
      if (line.length < 2 && !line.startsWith('#')) return false;
      return true;
    });
  
  return lines.join('\n');
}

/**
 * 计算文本中有意义的字符数（去 HTML 标签+去空白），用于判断文章内容是否足够。
 */
export function meaningfulTextLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length;
}
