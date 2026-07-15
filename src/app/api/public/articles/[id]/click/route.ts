import { NextResponse } from 'next/server';
import { recordOriginalClick } from '@/lib/public-article-service';
import { enforcePublicRateLimit } from '@/lib/public-rate-limit';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const limited = enforcePublicRateLimit(request);
  if (limited) return limited;
  const { id } = await params;
  const recorded = await recordOriginalClick(id);
  return NextResponse.json({ recorded }, { status: recorded ? 200 : 404 });
}
