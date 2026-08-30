import { z } from 'zod';

export const proxyUrlSchema = z.string()
  .trim()
  .max(2048, '代理地址不能超过 2048 个字符')
  .refine((value) => {
    if (!value) return true;
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
    } catch {
      return false;
    }
  }, '代理地址需为有效的 http:// 或 https:// URL');

export interface ProxyCandidate {
  url: string;
  label: string;
}

export interface ProxyTestResult {
  success: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

export interface ProxyCandidateTestResult extends ProxyCandidate, ProxyTestResult {}

export interface ProxyBatchTestResult {
  results: ProxyCandidateTestResult[];
  fastestUrl?: string;
  sourceCount: number;
  sourceErrors: string[];
}
