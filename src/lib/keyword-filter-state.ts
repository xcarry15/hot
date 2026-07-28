import { db } from '@/lib/db';

/**
 * `filter:*` 是当前关键词配置推导出的临时结论，不是永久去重记录。
 * 关键词发生任何实际变更后，必须清理它们，让同一 URL 在下次采集时重新判断。
 */
export async function invalidateKeywordFilterDiscards(): Promise<void> {
  await db.discardedItem.deleteMany({
    where: { reason: { startsWith: 'filter:' } },
  });
}
