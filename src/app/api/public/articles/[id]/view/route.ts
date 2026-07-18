import { NextResponse } from 'next/server';
import { recordPublicArticleView } from '@/lib/public-article-service';
import { enforcePublicRateLimit } from '@/lib/public-rate-limit';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const limited = enforcePublicRateLimit(request);
  if (limited) return limited;
  const { id } = await params;
  await recordPublicArticleView(id);
  return new NextResponse(null, { status: 204 });
}
