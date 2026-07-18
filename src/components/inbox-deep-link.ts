export type InboxDetailPanel = 'cluster' | 'content';

export interface InboxDeepLink {
  articleId: string | null;
  panel: InboxDetailPanel | null;
}

export function readInboxDeepLink(search: string): InboxDeepLink {
  const params = new URLSearchParams(search);
  const panel = params.get('panel');
  return {
    articleId: params.get('articleId'),
    panel: panel === 'cluster' || panel === 'content' ? panel : null,
  };
}

export function writeInboxDeepLink(urlValue: string, articleId: string | null, panel?: InboxDetailPanel | null): string {
  const url = new URL(urlValue);
  if (articleId) url.searchParams.set('articleId', articleId);
  else url.searchParams.delete('articleId');
  if (panel) url.searchParams.set('panel', panel);
  else if (panel === null) url.searchParams.delete('panel');
  return url.toString();
}

export function shouldExpandContentPanel(panel: InboxDetailPanel | null): boolean {
  return panel === 'content';
}
