import { describe, expect, it } from 'vitest';
import { comparePromptSnapshots, diffPromptLines } from '@/lib/prompt-diff';
import {
  DEFAULT_PROMPT_SETTINGS,
  type PromptVersionSnapshot,
} from '@/lib/prompts';

describe('prompt diff', () => {
  it('只显示两边不同的行，保留行的前后顺序', () => {
    expect(diffPromptLines('共同\n当前专有\n结尾', '共同\n版本专有\n结尾')).toEqual([
      { kind: 'current', value: '当前专有' },
      { kind: 'version', value: '版本专有' },
    ]);
  });

  it('按提示词字段汇总当前页面与保存版本的变化', () => {
    const current = { ...DEFAULT_PROMPT_SETTINGS } as PromptVersionSnapshot;
    current.ai_block_summary = '原摘要规则';
    const version = {
      ...current,
      ai_block_summary: '新的摘要规则',
    };

    expect(comparePromptSnapshots(current, version)).toEqual([
      {
        key: 'ai_block_summary',
        current: current.ai_block_summary,
        version: '新的摘要规则',
        lines: [
          { kind: 'current', value: '原摘要规则' },
          { kind: 'version', value: '新的摘要规则' },
        ],
      },
    ]);
  });
});
