import { db } from '@/lib/db';

/**
 * `filter:*` 是当前关键词配置推导出的临时结论，不是永久去重记录。
 * 通用关键词配置发生任何实际变更后，必须清理它们，让同一 URL 在下次采集时重新判断。
 * 工作台的“添加关键词并采集当前文章”走复合事务，只消费用户选中的记录，
 * 不调用这里的全量清理，避免当前目标被提前删除并让任务中心整批消失。
 */
export async function invalidateKeywordFilterDiscards(): Promise<void> {
  await db.discardedItem.deleteMany({
    where: { reason: { startsWith: 'filter:' } },
  });
}
