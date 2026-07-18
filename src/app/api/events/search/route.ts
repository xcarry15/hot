import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { searchActiveEvents } from '@/lib/event-service';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    return NextResponse.json(await searchActiveEvents(
      params.get('q') ?? '',
      params.get('excludeEventId') ?? undefined,
    ));
  } catch (error) {
    return apiError(error, '搜索事件失败');
  }
}
