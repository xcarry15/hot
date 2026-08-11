import QRCode from 'qrcode'
import sharp from 'sharp'
import { z } from 'zod'
import { PUBLIC_SITE_NAME, PUBLIC_SITE_TAGLINE } from '@/lib/public-brand'
import { enforcePublicRateLimit } from '@/lib/public-rate-limit'

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
  const limited = enforcePublicRateLimit(request)
  if (limited) return limited

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
  const summaryLines = wrapText(summary || '扫码查看文章详情与 AI 洞察。', 54, 5)
  const summaryY = 122 + titleLines.length * 31 + 24
  const fadeY = summaryY + summaryLines.length * 21 - 24
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="450" height="560" viewBox="0 0 450 560">
      <defs>
        <filter id="poster-shadow" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB">
          <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#141413" flood-opacity="0.12"/>
        </filter>
        <linearGradient id="fade-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="1"/>
        </linearGradient>
        <linearGradient id="fade-gradient-top" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="1"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect x="27" y="27" width="396" height="504" fill="#ffffff" stroke="#e5e5e5" stroke-width="1" filter="url(#poster-shadow)"/>
      <g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif">
        <text x="52" y="62" fill="#141413" font-size="15" font-weight="700">${escapeXml(PUBLIC_SITE_NAME)}</text>
        <text x="398" y="62" fill="#888888" font-size="9" font-weight="500" text-anchor="end">${escapeXml(publishedAt)}</text>
        <line x1="52" y1="89" x2="398" y2="89" stroke="#e5e5e5" stroke-width="1"/>
        ${textLines(titleLines, 52, 122, 31, 'fill="#141413" font-size="24" font-weight="700"')}
        <rect x="52" y="${summaryY}" width="346" height="16" fill="url(#fade-gradient-top)"/>
        ${textLines(summaryLines, 52, summaryY, 21, 'fill="#666666" font-size="14" font-weight="400"')}
        <rect x="52" y="${fadeY}" width="346" height="16" fill="url(#fade-gradient)"/>
        <line x1="52" y1="429" x2="398" y2="429" stroke="#e5e5e5" stroke-width="1"/>
        <rect x="52" y="446" width="75" height="75" fill="#ffffff"/>
        <image href="${qrDataUrl}" x="52" y="446" width="75" height="75"/>
        <text x="145" y="471" fill="#141413" font-size="11" font-weight="700">扫码阅读完整文章</text>
        <text x="145" y="490" fill="#888888" font-size="9">${escapeXml(PUBLIC_SITE_TAGLINE)}</text>
        <text x="145" y="509" fill="#888888" font-size="9">hot.kfxz.cn</text>
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
