import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { retrySource } from '@/lib/source-actions';

export async function POST(request: Request) {
  try {
    const result = await retrySource(await request.json());
    if ('status' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch (error: unknown) {
    return apiError(error, 'Retry failed');
  }
}
