import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { InvalidParserConfigError, getSourceDetail, softDeleteSource, updateSource } from '@/lib/source-service';
import { formatSourceSchemaError, sourceUpdateSchema } from '@/lib/source-schema';
import { runExclusiveMutation } from '@/lib/mutation-guard';

// GET /api/sources/[id]
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const source = await getSourceDetail(id);
    if (!source) {
      return NextResponse.json({ error: 'Source not found' }, { status: 404 });
    }
    return NextResponse.json(source);
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch source');
  }
}

// PUT /api/sources/[id] - Update a source
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsed = sourceUpdateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatSourceSchemaError(parsed.error) },
        { status: 400 },
      );
    }
    const source = await runExclusiveMutation('更新数据源', () => updateSource(id, parsed.data));

    return NextResponse.json(source);
  } catch (error: unknown) {
    if (error instanceof InvalidParserConfigError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return apiError(error, 'Failed to update source');
  }
}

// DELETE /api/sources/[id] - Soft delete
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const source = await runExclusiveMutation('删除数据源', () => softDeleteSource(id));

    return NextResponse.json(source);
  } catch (error: unknown) {
    return apiError(error, 'Failed to delete source');
  }
}
