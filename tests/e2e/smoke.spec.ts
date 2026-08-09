import { expect, test } from '@playwright/test';

const ADMIN_TOKEN = process.env.API_TOKEN ?? 'ci-only-token';
const BACKUP_PASSWORD = 'ci-e2e-backup-password';

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

test('encrypted backup rejects a wrong password and opens restore confirmation', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('tab', { name: '备份' }).click();
  await expect(page.getByText('完整配置备份')).toBeVisible();

  const password = page.getByPlaceholder('备份保护密码（至少 12 位）');
  const confirmation = page.getByPlaceholder('确认备份保护密码（下载时校验）');
  await password.fill(BACKUP_PASSWORD);
  await confirmation.fill(BACKUP_PASSWORD);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载加密备份' }).click();
  const download = await downloadPromise;
  const backupPath = await download.path();
  expect(backupPath).toBeTruthy();

  await password.fill('wrong-password-123');
  await page.locator('input[type="file"][accept*="application/json"]').setInputFiles(backupPath!);
  await expect(page.getByText('备份密码错误或文件已损坏')).toBeVisible();

  await password.fill(BACKUP_PASSWORD);
  await page.locator('input[type="file"][accept*="application/json"]').setInputFiles(backupPath!);
  await expect(page.getByRole('heading', { name: '确认恢复完整备份？' })).toBeVisible();
});
