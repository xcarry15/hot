/**
 * 敏感设置密钥轮换工具（P0-3）。
 *
 * 用法（密钥只从环境变量读取，绝不走 argv，避免进入 shell history）：
 *   # 预览（默认，不写库）
 *   SETTINGS_ENCRYPTION_KEY=<旧密钥> SETTINGS_ENCRYPTION_KEY_NEW=<新密钥> \
 *     npx tsx scripts/rotate-settings-key.ts
 *   # 真正写入（单事务原子轮换 + 轮换后校验 + 失败自动回滚）
 *   SETTINGS_ENCRYPTION_KEY=<旧密钥> SETTINGS_ENCRYPTION_KEY_NEW=<新密钥> \
 *     npx tsx scripts/rotate-settings-key.ts --apply
 *
 * 行为约定：
 *   - 默认 dry-run，只有显式 --apply 才写数据库。
 *   - 旧密钥解密 → 新密钥重加密；envelope 写入新的 keyId 与 AAD 绑定。
 *   - 全部更新在单个事务内完成；事务内用新密钥逐条校验，任何失败都回滚。
 *   - 全程只输出条数与设置键名，不打印密钥、密文或明文。
 *   - 不修改 .env、不重启服务；轮换完成后需把 SETTINGS_ENCRYPTION_KEY 更新为新密钥。
 */
import { PrismaClient } from '@prisma/client';
import { SETTING_KEYS, SENSITIVE_SETTING_KEYS } from '@/lib/settings-catalog';
import {
  canDecryptWithSecret,
  containsEncryptedSettingValue,
  reencryptSettingValueForRotation,
} from '@/lib/settings-crypto';

function fail(message: string): never {
  console.error(`[rotate-settings-key] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function parseArgs(argv: string[]): { apply: boolean; help: boolean } {
  const result = { apply: false, help: false };
  for (const arg of argv) {
    if (arg === '--apply') result.apply = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else fail(`未知参数：${arg}（仅支持 --apply / --help）`);
  }
  return result;
}

function rotationKind(key: string): 'text' | 'webhook' {
  return key === SETTING_KEYS.FEISHU_WEBHOOK_URL ? 'webhook' : 'text';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：SETTINGS_ENCRYPTION_KEY=<旧> SETTINGS_ENCRYPTION_KEY_NEW=<新> npx tsx scripts/rotate-settings-key.ts [--apply]');
    return;
  }

  const oldSecret = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  const newSecret = (process.env.SETTINGS_ENCRYPTION_KEY_NEW || process.env.NEW_SETTINGS_ENCRYPTION_KEY)?.trim();
  if (!oldSecret) fail('缺少旧密钥：请设置环境变量 SETTINGS_ENCRYPTION_KEY');
  if (!newSecret) fail('缺少新密钥：请设置环境变量 SETTINGS_ENCRYPTION_KEY_NEW');
  if (oldSecret === newSecret) fail('新旧密钥不能相同，无需轮换');

  const prisma = new PrismaClient();
  try {
    // 用 CAST 读取以兼容历史遗留的 BLOB value；Prisma 的类型化查询遇到 BLOB
    // 会直接抛错，导致整个轮换无法进行。CAST 后仅筛选真正含 envelope 的敏感键。
    const rows = await prisma.$queryRawUnsafe<Array<{ key: string; value: string }>>(
      'SELECT key, CAST(value AS TEXT) AS value FROM settings',
    );
    const targets = rows.filter((row) => SENSITIVE_SETTING_KEYS.has(row.key) && containsEncryptedSettingValue(row.value));

    if (targets.length === 0) {
      console.log('[rotate-settings-key] 未发现需要轮换的 enc:v1 设置，无需操作');
      return;
    }

    // 先在事务外用旧密钥完整解密 + 新密钥重加密，尽早暴露失败，且不触碰数据库。
    const plan = targets.map((row) => {
      const kind = rotationKind(row.key);
      const newValue = reencryptSettingValueForRotation(row.value, oldSecret, newSecret, kind);
      return { key: row.key, kind, newValue };
    });

    console.log(`[rotate-settings-key] ${args.apply ? 'APPLY' : 'DRY-RUN'}：待轮换 ${plan.length} 个敏感设置`);
    console.log(`[rotate-settings-key] 设置键：${plan.map((item) => item.key).join(', ')}`);

    if (!args.apply) {
      console.log('[rotate-settings-key] 预览完成，未写入数据库；确认无误后加 --apply 执行');
      return;
    }

    // 单事务原子写入 + 事务内用新密钥校验；任何异常都会回滚整个事务。
    await prisma.$transaction(async (tx) => {
      for (const item of plan) {
        await tx.setting.update({ where: { key: item.key }, data: { value: item.newValue } });
      }
      const verifyRows = await tx.setting.findMany({
        where: { key: { in: plan.map((item) => item.key) } },
        select: { key: true, value: true },
      });
      const verifyMap = new Map(verifyRows.map((row) => [row.key, row.value]));
      for (const item of plan) {
        const stored = verifyMap.get(item.key);
        if (stored === undefined || !canDecryptWithSecret(stored, newSecret, item.kind)) {
          throw new Error(`轮换后校验失败：${item.key}（事务将回滚）`);
        }
      }
    }, { maxWait: 10_000, timeout: 30_000 });

    console.log(`[rotate-settings-key] 完成：${plan.length} 个敏感设置已原子轮换，全部用新密钥校验通过`);
    console.log('[rotate-settings-key] 请同步把运行环境中的 SETTINGS_ENCRYPTION_KEY 更新为新密钥');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[rotate-settings-key] 失败：', error instanceof Error ? error.message : '未知错误');
  process.exitCode = 1;
});
