import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getDashboardStats } from '@/lib/dashboard-service';

// GET /api/dashboard - Dashboard stats
export async function GET() {
  try {
    return NextResponse.json(await getDashboardStats());
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch dashboard');
  }
}
