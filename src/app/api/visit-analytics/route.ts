import { NextResponse } from 'next/server';
import { validVisitRange } from '@/lib/visit-analytics-service';
import { getVisitAnalyticsReport } from '@/lib/visit-analytics-report-service';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const start = params.get('start') || '';
  const end = params.get('end') || '';
  if (!validVisitRange(start, end)) return NextResponse.json({ error: '日期范围无效' }, { status: 400 });
  return NextResponse.json(await getVisitAnalyticsReport(start, end));
}
