// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { readInboxDeepLink, shouldExpandContentPanel, writeInboxDeepLink } from '@/components/inbox-deep-link';

describe('inbox deep link', () => {
  it('解析 cluster/content 并忽略无效 panel', () => {
    expect(readInboxDeepLink('?articleId=a1&panel=cluster')).toEqual({ articleId: 'a1', panel: 'cluster' });
    expect(readInboxDeepLink('?articleId=a1&panel=content')).toEqual({ articleId: 'a1', panel: 'content' });
    expect(readInboxDeepLink('?articleId=a1&panel=bad')).toEqual({ articleId: 'a1', panel: null });
  });
  it('URL 删除 articleId/panel 后状态可清空', () => {
    const next = writeInboxDeepLink('http://localhost/admin?articleId=a1&panel=content', null, null);
    expect(readInboxDeepLink(new URL(next).search)).toEqual({ articleId: null, panel: null });
  });
  it('content 入口要求展开正文', () => {
    expect(shouldExpandContentPanel('content')).toBe(true);
    expect(shouldExpandContentPanel('cluster')).toBe(false);
  });
});
