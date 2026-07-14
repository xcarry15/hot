/**
 * 重构 #4：article-pipeline-status.ts 投影规则测试。
 *
 * 这些断言是冻结的——任何调整都必须同步更新 push.ts 的 pushableWhere
 * 并在 PR 中说明理由（见重构报告 12.6 / 12.12）。
 */

import { describe, expect, it } from 'vitest';
import {
  projectArticleSteps,
  withRunningOverlay,
  deriveSkipReason,
  type ArticleStepInput,
  type PushThresholds,
} from '@/lib/article-pipeline-status';

const now = new Date('2026-07-10T12:00:00Z');

function push(overrides: Partial<PushThresholds> = {}): PushThresholds {
  return {
    pushMode: 'realtime',
    minScore: 50,
    minRelevance: 5,
    now,
    ...overrides,
  };
}

function article(overrides: Partial<ArticleStepInput> = {}): ArticleStepInput {
  return {
    fetchStatus: 'fetched',
    aiStatus: 'done',
    score: 70,
    relevance: 7,
    pushedAt: null,
    nextRetryAt: null,
    ...overrides,
  };
}

describe('article-pipeline-status — crawl', () => {
  it('Article 行存在 → crawl=done', () => {
    const proj = projectArticleSteps(article(), push());
    expect(proj.crawl).toBe('done');
  });
});

describe('article-pipeline-status — process', () => {
  it('fetchStatus=fetched → done', () => {
    expect(projectArticleSteps(article({ fetchStatus: 'fetched' }), push()).process).toBe('done');
  });
  it('fetchStatus=failed → failed', () => {
    expect(projectArticleSteps(article({ fetchStatus: 'failed' }), push()).process).toBe('failed');
  });
  it('fetchStatus=pending → pending', () => {
    expect(projectArticleSteps(article({ fetchStatus: 'pending' }), push()).process).toBe('pending');
  });
});

describe('article-pipeline-status — ai', () => {
  it('process 未完成 → blocked（即使 aiStatus=done）', () => {
    const proj = projectArticleSteps(article({ fetchStatus: 'pending', aiStatus: 'done' }), push());
    expect(proj.ai).toBe('blocked');
  });
  it('aiStatus=done 且 process=done → done', () => {
    const proj = projectArticleSteps(article({ aiStatus: 'done' }), push());
    expect(proj.ai).toBe('done');
  });
  it('aiStatus=skipped 且 process=done → skipped', () => {
    const proj = projectArticleSteps(article({ aiStatus: 'skipped' }), push());
    expect(proj.ai).toBe('skipped');
  });
  it('aiStatus=failed 且 process=done → failed', () => {
    const proj = projectArticleSteps(article({ aiStatus: 'failed' }), push());
    expect(proj.ai).toBe('failed');
  });
  it('aiStatus=pending 且 process=done → pending', () => {
    const proj = projectArticleSteps(article({ aiStatus: 'pending' }), push());
    expect(proj.ai).toBe('pending');
  });
});

describe('article-pipeline-status — push', () => {
  it('pushedAt 有值 → done', () => {
    const proj = projectArticleSteps(article({ pushedAt: new Date() }), push());
    expect(proj.push).toBe('done');
  });
  it('process 未完成 → blocked', () => {
    const proj = projectArticleSteps(article({ fetchStatus: 'pending' }), push());
    expect(proj.push).toBe('blocked');
  });
  it('AI 为 skipped → not_applicable', () => {
    const proj = projectArticleSteps(article({ aiStatus: 'skipped' }), push());
    expect(proj.push).toBe('not_applicable');
  });
  it('AI 为 failed → not_applicable', () => {
    const proj = projectArticleSteps(article({ aiStatus: 'failed' }), push());
    expect(proj.push).toBe('not_applicable');
  });
  it('push_mode=off → not_applicable', () => {
    const proj = projectArticleSteps(article(), push({ pushMode: 'off' }));
    expect(proj.push).toBe('not_applicable');
  });
  it('AI 已完成但 score < minScore → filtered', () => {
    const proj = projectArticleSteps(article({ score: 30 }), push({ minScore: 50 }));
    expect(proj.push).toBe('filtered');
  });
  it('AI 已完成但 relevance < minRelevance → filtered', () => {
    const proj = projectArticleSteps(article({ relevance: 3 }), push({ minRelevance: 5 }));
    expect(proj.push).toBe('filtered');
  });
  it('score 正好 = minScore → 不算 filtered（应 pending）', () => {
    const proj = projectArticleSteps(article({ score: 50 }), push({ minScore: 50 }));
    expect(proj.push).toBe('pending');
  });
  it('relevance 正好 = minRelevance → 不算 filtered', () => {
    const proj = projectArticleSteps(article({ relevance: 5 }), push({ minRelevance: 5 }));
    expect(proj.push).toBe('pending');
  });
  it('nextRetryAt 未到期 → failed 并返回 retryAt', () => {
    const retryAt = new Date(now.getTime() + 3600_000);
    const proj = projectArticleSteps(article({ nextRetryAt: retryAt }), push());
    expect(proj.push).toBe('failed');
    expect(proj.pushRetryAt).toBe(retryAt.toISOString());
  });
  it('nextRetryAt 已过期 → pending', () => {
    const retryAt = new Date(now.getTime() - 3600_000);
    const proj = projectArticleSteps(article({ nextRetryAt: retryAt }), push());
    expect(proj.push).toBe('pending');
  });
  it('nextRetryAt=null + 满足阈值 → pending', () => {
    const proj = projectArticleSteps(article(), push());
    expect(proj.push).toBe('pending');
  });
});

describe('article-pipeline-status — isInProgress 聚合', () => {
  it('低分文章不计入进行中', () => {
    const proj = projectArticleSteps(article({ score: 30 }), push({ minScore: 50 }));
    expect(proj.isInProgress).toBe(false);
  });
  it('AI skipped 不计入进行中', () => {
    const proj = projectArticleSteps(article({ aiStatus: 'skipped' }), push());
    expect(proj.isInProgress).toBe(false);
  });
  it('push_mode=off 不计入进行中', () => {
    const proj = projectArticleSteps(article(), push({ pushMode: 'off' }));
    expect(proj.isInProgress).toBe(false);
  });
  it('pending 文章计入进行中', () => {
    const proj = projectArticleSteps(article({ fetchStatus: 'pending' }), push());
    expect(proj.isInProgress).toBe(true);
  });
});

describe('withRunningOverlay', () => {
  it('activeStage=process + process=pending → process=running', () => {
    const base = projectArticleSteps(article({ fetchStatus: 'pending' }), push());
    const overlay = withRunningOverlay(base, 'process');
    expect(overlay.process).toBe('running');
  });
  it('activeStage 不匹配当前步骤 → 不升级', () => {
    const base = projectArticleSteps(article(), push());
    const overlay = withRunningOverlay(base, 'ai');
    expect(overlay.process).toBe('done');
    expect(overlay.ai).toBe('done');
  });
  it('activeStage=null → 不升级', () => {
    const base = projectArticleSteps(article(), push());
    const overlay = withRunningOverlay(base, null);
    expect(overlay.process).toBe('done');
  });
  it('done 不会被覆盖为 running', () => {
    const base = projectArticleSteps(article(), push());
    const overlay = withRunningOverlay(base, 'process');
    expect(overlay.ai).toBe('done');
    expect(overlay.push).toBe('pending'); // pending → running via push stage
  });
});

describe('deriveSkipReason', () => {
  it('aiStatus=skipped + skipReason 存在 → 透传', () => {
    expect(deriveSkipReason({ aiStatus: 'skipped', skipReason: '内容不足', summary: '' }))
      .toBe('内容不足');
  });
  it('aiStatus=skipped + skipReason 为空 + summary 存在 → 透传 summary', () => {
    expect(deriveSkipReason({ aiStatus: 'skipped', skipReason: null, summary: 'AI 跳过' }))
      .toBe('AI 跳过');
  });
  it('aiStatus=done + 非 [重复] skipReason → undefined', () => {
    expect(deriveSkipReason({ aiStatus: 'done', skipReason: '其他原因', summary: '' }))
      .toBeUndefined();
  });
  it('aiStatus=done + skipReason=[重复]... → 透传（去重提示）', () => {
    expect(deriveSkipReason({ aiStatus: 'done', skipReason: '[重复] 命中', summary: '' }))
      .toBe('[重复] 命中');
  });
});