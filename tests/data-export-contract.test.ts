import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_FILTER,
  exportFilterSchema,
  exportJobStatusSchema,
} from '@/contracts/data-export';

describe('Excel 导出契约', () => {
  it('空筛选条件使用全部文章和未入库记录的默认范围', () => {
    expect(exportFilterSchema.parse({})).toEqual(DEFAULT_EXPORT_FILTER);
  });

  it('拒绝未知状态和无效日期字段，避免服务层生成不可执行查询', () => {
    expect(exportFilterSchema.safeParse({ fetchStatuses: ['unknown'] }).success).toBe(false);
    expect(exportFilterSchema.safeParse({ dateField: 'created' }).success).toBe(false);
  });

  it('覆盖全部持久化任务状态', () => {
    expect(exportJobStatusSchema.options).toEqual([
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'expired',
    ]);
  });
});
