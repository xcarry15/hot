import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import {
  addKeyword, addKeywordsText, clearKeywords, deleteKeyword, importKeywordsCsv,
  keywordsToCsv, listKeywords,
} from '@/lib/keyword-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { listKeywordCandidates, updateKeywordCandidate } from '@/lib/keyword-candidate-service';
import { runJob } from '@/lib/execution';

// GET /api/keywords - List all keywords
//   ?format=csv   → export as CSV
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format');
    if (searchParams.get('candidates') === 'true') return NextResponse.json(await listKeywordCandidates());

    const keywords = await listKeywords();

    if (format === 'csv') {
      return new NextResponse(keywordsToCsv(keywords), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="keywords.csv"',
        },
      });
    }

    return NextResponse.json(keywords);
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch keywords');
  }
}

// POST /api/keywords - Add keyword(s)
//   { word }              → 单个添加
//   { text }              → 批量添加（每行一个词，category=default）
//   { action: 'import-csv', csv: '类型,关键词\\n正面,xxx' }  → CSV 导入
export async function POST(request: Request) {
  try {
    const result = await runExclusiveMutation('更新关键词', async () => {
      const body = await request.json();
      if ((body.action === 'approve-candidate' || body.action === 'dismiss-candidate') && typeof body.id === 'string') {
        const result = await updateKeywordCandidate(body.id, body.action === 'approve-candidate' ? 'approve' : 'dismiss');
        if (!result) return { kind: 'invalid' as const };
        return { kind: 'candidate' as const, data: result };
      }
      if (body.action === 'import-csv' && body.csv) {
        return { kind: 'ok' as const, data: await importKeywordsCsv(String(body.csv)) };
      }
      if (body.text) {
        const data = await addKeywordsText(String(body.text), body.category);
        return data ? { kind: 'ok' as const, data } : { kind: 'invalid' as const };
      }
      if (!body.word) return { kind: 'invalid' as const };
      return { kind: 'created' as const, data: await addKeyword(String(body.word)) };
    });
    if (result.kind === 'invalid') {
      return NextResponse.json({ error: '未输入任何关键词' }, { status: 400 });
    }
    if (result.kind === 'candidate') {
      const processQueued = result.data.action === 'approve' && result.data.restored > 0
        ? (await runJob('process', { trigger: 'keyword-candidate', candidateId: result.data.id })).queued
        : false;
      return NextResponse.json({ ...result.data, processQueued });
    }
    if (result.kind === 'ok') return NextResponse.json(result.data);

    return NextResponse.json(result.data, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      return NextResponse.json({ error: '关键词已存在' }, { status: 409 });
    }
    return apiError(error, 'Failed to add keywords');
  }
}

// PUT /api/keywords - Bulk operations
//   action='clear-all'     : 清空所有关键词
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'clear-all') {
      return NextResponse.json({
        success: true,
        deleted: await runExclusiveMutation('清空关键词', clearKeywords),
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error: unknown) {
    return apiError(error, 'Failed to update keywords');
  }
}

// DELETE /api/keywords - Delete a keyword
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'ID is required' }, { status: 400 });
    }

    await runExclusiveMutation('删除关键词', () => deleteKeyword(id));
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return apiError(error, 'Failed to delete keyword');
  }
}
