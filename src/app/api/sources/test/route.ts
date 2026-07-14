import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { testSourceParsing } from '@/lib/source-actions';

export async function POST(request: Request) {
  try {
    const result = await testSourceParsing(await request.json().catch(() => ({})));
    if ('status' in result && result.status === 400) {
      return NextResponse.json(
        { success: false, items: [], error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json(result);
  } catch (error: unknown) {
    return apiError(error, 'Test crawl failed');
  }
}
