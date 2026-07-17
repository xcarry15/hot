import QRCode from 'qrcode'
import sharp from 'sharp'
import { z } from 'zod'

const requestSchema = z.object({
  publishedAt: z.string().trim().max(50),
  shareUrl: z.string().url().max(2000),
  summary: z.string().trim().max(2000),
  title: z.string().trim().min(1).max(300),
})

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char] ?? char)
}

function visualLength(char: string) {
  return /[\u0000-\u00ff]/.test(char) ? 1 : 2
}

function wrapText(value: string, maxLength: number, maxLines: number) {
  const chars = value.replace(/\s+/g, ' ').trim().split('')
  const lines: string[] = []
  let line = ''
  let length = 0
  for (const char of chars) {
    const nextLength = length + visualLength(char)
    if (line && nextLength > maxLength) {
      lines.push(line)
      if (lines.length === maxLines) break
      line = char
      length = visualLength(char)
    } else {
      line += char
      length = nextLength
    }
  }
  if (line && lines.length < maxLines) lines.push(line)
  if (lines.length === maxLines && chars.join('').length > lines.join('').length) lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`
  return lines.map(escapeXml)
}

function textLines(lines: string[], x: number, y: number, lineHeight: number, attributes: string) {
  return `<text x="${x}" y="${y}" ${attributes}>${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${line}</tspan>`).join('')}</text>`
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: '参数错误' }, { status: 400 })

  const { publishedAt, shareUrl, summary, title } = parsed.data
  const qrDataUrl = await QRCode.toDataURL(shareUrl, {
    width: 300,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: { dark: '#141413', light: '#ffffff' },
  })
  const titleLines = wrapText(title, 34, 4)
  const summaryLines = wrapText(summary || '扫码查看文章详情与 AI 洞察。', 54, 7)
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="1120" viewBox="0 0 900 1120">
      <defs>
        <filter id="poster-shadow" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB">
          <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#59483b" flood-opacity="0.28"/>
          <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#59483b" flood-opacity="0.16"/>
        </filter>
      </defs>
      <rect width="900" height="1120" fill="#f3eee6"/>
      <rect width="900" height="18" fill="#cc785c"/>
      <rect x="54" y="54" width="792" height="1008" fill="#fffdf9" stroke="#d6cfc4" stroke-width="2" filter="url(#poster-shadow)"/>
      <g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif">
        <text x="104" y="125" fill="#141413" font-size="30" font-weight="700">行业新闻聚合</text>
        <text x="796" y="124" fill="#8e8b82" font-size="18" font-weight="500" text-anchor="end">${escapeXml(publishedAt)}</text>
        <line x1="104" y1="178" x2="796" y2="178" stroke="#d6cfc4" stroke-width="2"/>
        ${textLines(titleLines, 104, 245, 62, 'fill="#141413" font-size="43" font-weight="700"')}
        ${textLines(summaryLines, 104, 245 + titleLines.length * 62 + 48, 42, 'fill="#4f4d48" font-size="24" font-weight="400"')}
        <line x1="104" y1="858" x2="796" y2="858" stroke="#e6dfd8" stroke-width="2"/>
        <rect x="104" y="893" width="150" height="150" fill="#ffffff"/>
        <image href="${qrDataUrl}" x="104" y="893" width="150" height="150"/>
        <text x="290" y="942" fill="#141413" font-size="22" font-weight="700">扫码阅读完整文章</text>
        <text x="290" y="980" fill="#8e8b82" font-size="18">行业动态 · 品牌资讯 · AI 洞察</text>
        <text x="290" y="1018" fill="#8e8b82" font-size="18">hot.kfxz.cn</text>
      </g>
    </svg>`
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  return new Response(new Uint8Array(png), {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="share-poster.png"',
      'Content-Type': 'image/png',
    },
  })
}
