import { describe, expect, it } from 'vitest';
import { summarizeAIError } from '@/lib/ai-error';

describe('summarizeAIError', () => {
  it('只保留稳定的错误类别和状态码，不保存模型原始内容', () => {
    expect(summarizeAIError({
      kind: 'provider',
      status: 503,
      message: '模型回显了不应进入数据库的文章正文',
    })).toBe('AI 服务暂不可用（503）');
  });

  it('未知异常使用通用摘要，避免把任意异常文本写入文章状态', () => {
    expect(summarizeAIError(new Error('包含文章正文和内部请求细节'))).toBe('AI 分析失败');
  });

  it('超时和限流保留可运营识别信息', () => {
    expect(summarizeAIError({ kind: 'timeout', status: undefined })).toBe('AI 请求超时');
    expect(summarizeAIError({ kind: 'rate_limit', status: 429 })).toBe('AI 请求受限（429）');
  });
});
