/**
 * Content cleaner v2 - preserves heading structure for AI
 *
 * Output modes:
 * 0. extractArticleBody() → extract article body HTML from full page
 * 1. cleanContent() → pure text (for display)
 * 2. cleanContentMarkdown() → Markdown with heading hierarchy (for AI)
 * 3. meaningfulTextLength() → 有意义文本字符数（去标签+去空白）
 */

import * as cheerio from 'cheerio';

// 按实际正文容器取 DOM 子树，不能从开始标签一直取到整页末尾。
const ARTICLE_BODY_SELECTORS = [
  '.content-editor', '.cd_content .con_text', '.cd_content', '.post-text', '.win-news-content',
  '.article-content', '.post-content', '.post-body', '.article-body',
  '.entry-content', '.news_content', '.detail_content', '.art_content',
  '.cont_text', '.rich_media_content', 'article', '.content',
];

const HTML_NOISE_SELECTOR = [
  'script', 'style', 'nav', 'footer', 'aside', 'header',
  '.extra', '.module_body', '.instructions', '.share_box', '.share-box',
  '.win-news-links', '.win-new-list1', '.post-header', '.read-content',
  '.ai-article-content', '.article-faq-panel',
  '[class*="comment"]', '[class*="sidebar"]', '[class*="related"]',
  '[class*="recommend"]', '[class*="copyright"]',
].join(', ');

/** 保留来源指定容器；仅对已知宽容器收缩到明确的原文子树。 */
export function extractArticleBody(fullHtml: string, contentSelector?: string): string {
  if (!fullHtml) return '';
  const $ = cheerio.load(fullHtml);
  const root = $.root();
  let scope: ReturnType<typeof $> = root;
  if (contentSelector?.trim()) {
    try {
      const selected = $(contentSelector).first();
      if (selected.length) {
        const original = selected.is('section.article-content-module')
          ? selected.find('.post-text').first()
          : selected.is('.cd_content') ? selected.find('.con_text').first() : selected;
        scope = original.length ? original : selected;
        scope.find(HTML_NOISE_SELECTOR).remove();
        return scope.html() || '';
      }
    } catch {
      // 无效选择器回退通用提取；已找到但正文不足的容器不能用整页噪声补足。
    }
  }
  for (const selector of ARTICLE_BODY_SELECTORS) {
    const body = scope.is(selector) ? scope : scope.find(selector).first();
    if (!body.length) continue;
    body.find(HTML_NOISE_SELECTOR).remove();
    return body.html() || '';
  }
  const body: ReturnType<typeof $> = scope.is('html') || scope.is('body') || scope === root
    ? $('body') : scope;
  body.find(HTML_NOISE_SELECTOR).remove();
  return body.html() || '';
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
  /^\s*举报\s*$/gm,
  /^\s*广告\s*$/gm,
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
  // 主防线在 extractArticleBody 的 DOM 容器提取。
  /你可能会喜欢：?[\s\S]*?(?=\n)/gi,
  /\d+小时关注榜[\s\S]*?(?=\n)/gi,
  /发表评论[\s\S]*?(?=\n)/gi,
  /登录\s*[|｜]\s*注册[\s\S]*?(?=\n)/gi,
  /分享至：\s*\d*/gi,
  /本文为[\s\S]*?(?:转载|授权|所有|立场)[\s\S]*?(?=\n)/gi,
  /转载请联系[\s\S]*?(?=\n)/gi,
  /本站所有[\s\S]*?(?=\n)/gi,
];

/** DOM 删除噪声块，保留嵌套正文及段落结束边界。 */
function removeHtmlNoise(html: string): string {
  if (!/<[a-z][a-z0-9:-]*(?:\s|\/?>)/i.test(html)) return html;
  const $ = cheerio.load(html, {}, false);
  $(HTML_NOISE_SELECTOR).remove();
  return $.html();
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
