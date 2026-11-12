import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const ADMIN_TOKEN = process.env.API_TOKEN ?? 'ci-only-token';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByPlaceholder('API Token').fill(ADMIN_TOKEN);
  await page.getByRole('button', { name: '进入后台' }).click();
  await expect(page).toHaveURL(/\/admin(?:\?|$)/);
}

test('admin login reaches the protected workbench', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('button', { name: '工作台' })).toBeVisible();
  await expect(page.getByRole('button', { name: '设置' })).toBeVisible();
});

test('访问统计展示指标、趋势与文章排行，并随日期筛选更新', async ({ page }) => {
  await page.route('**/api/visit-analytics?*', async (route) => {
    await route.fulfill({ json: {
      geoConfigured: true, visitors: 2, visits: 3, views: 5, clicks: 1, articleViews: 4, originalClicks: 2,
      previous: { start: '2026-01-01', end: '2026-01-30', visitors: 1, visits: 3, views: 0, clicks: 1, articleViews: 2, originalClicks: 1 },
      daily: [], channels: [{ label: '直接访问', visits: 3, visitors: 2 }], regions: [], tools: [{ label: '工具', count: 1 }],
      topViewedArticles: [{ id: 'article-1', title: '测试资讯', viewCount: 4, publishedAt: null, score: 80, sourceName: '测试来源' }],
    } });
  });
  await login(page);
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('tab', { name: '访问统计' }).click();
  await expect(page.getByText('资讯确认浏览', { exact: true })).toBeVisible();
  await expect(page.getByText('较上期 +100.0%').first()).toBeVisible();
  await expect(page.getByText('上期 0 · 不计算增幅')).toBeVisible();
  await page.getByRole('button', { name: '资讯浏览', exact: true }).click();
  await expect(page.getByRole('img', { name: /每日资讯浏览趋势/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '公开浏览 Top 20' })).toBeVisible();
  await expect(page.getByRole('button', { name: /测试资讯/ })).toBeVisible();
  await page.getByText('查看每日明细').click();
  await expect(page.getByRole('columnheader', { name: '页面浏览' })).toBeVisible();
  const nextRequest = page.waitForRequest((request) => request.url().includes('/api/visit-analytics?') && request.method() === 'GET');
  await page.getByRole('button', { name: '近 7 天' }).click();
  await nextRequest;
  await expect(page.getByRole('heading', { name: '公开浏览 Top 20' })).toBeVisible();
});

test('public news page loads its empty or populated feed', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/资讯/);
  await expect(page.getByRole('heading', { name: '行业资讯' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Internal Server Error');
});

test('tool directory distinguishes clickable and unavailable tools', async ({ page }) => {
  await page.goto('/tools');
  await expect(page).toHaveTitle(/工具/);
  const cards = page.locator('main li');
  await expect(cards).not.toHaveCount(0);
  await expect(cards.locator('a').first()).toHaveAttribute('href', /^https:\/\//);
  await expect(cards.locator('[aria-disabled="true"]').first()).toBeVisible();
  await expect(cards.locator('[aria-disabled="true"] a')).toHaveCount(0);
});

test('backup encrypts the snapshot and decrypts it before restore confirmation', async ({ page }) => {
  const passphrase = 'ci-backup-passphrase';
  await login(page);
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('tab', { name: '备份' }).click();
  await expect(page.getByText('完整配置备份')).toBeVisible();

  await page.getByRole('button', { name: '下载备份', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置备份保护密码' })).toBeVisible();
  await page.getByLabel('保护密码', { exact: true }).fill(passphrase);
  await page.getByLabel('确认保护密码').fill(passphrase);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '加密并下载' }).click();
  const download = await downloadPromise;
  const backupPath = await download.path();
  expect(backupPath).toBeTruthy();
  const serialized = await readFile(backupPath!, 'utf8');
  const envelope = JSON.parse(serialized) as Record<string, unknown>;
  expect(envelope).toMatchObject({ type: 'hot2-encrypted-project-backup', version: 1 });
  expect(envelope).toHaveProperty('ciphertext');
  expect(envelope).not.toHaveProperty('settings');

  await page.locator('input[type="file"][accept*="json"]').setInputFiles(backupPath!);
  await expect(page.getByRole('heading', { name: '输入备份保护密码' })).toBeVisible();
  await page.getByLabel('保护密码', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: '解密备份' }).click();
  await expect(page.getByRole('heading', { name: '确认恢复完整备份？' })).toBeVisible();
});
