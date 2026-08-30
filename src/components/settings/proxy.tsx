'use client'

import { useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { CheckCircle2, Clock3, Globe2, Loader2, Zap, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import type { ProxyCandidate } from '@/contracts/proxy'
import {
  testAllOutboundProxies,
  testOutboundProxy,
  type ProxyTestResult,
} from '@/features/settings-api.client'
import type { Settings } from './types'

interface Props {
  settings: Settings
  setSettings: React.Dispatch<React.SetStateAction<Settings>>
  sensitiveStatus: 'idle' | 'loading' | 'ready' | 'error'
  onRetrySensitive: () => void
}

export default function ProxyTab({ settings, setSettings, sensitiveStatus, onRetrySensitive }: Props) {
  const [testing, setTesting] = useState(false)
  const [testingAll, setTestingAll] = useState(false)
  const [result, setResult] = useState<ProxyTestResult | null>(null)
  const [testingCandidates, setTestingCandidates] = useState<Record<string, boolean>>({})
  const [candidateResults, setCandidateResults] = useState<Record<string, ProxyTestResult>>({})
  const [candidates, setCandidates] = useState<ProxyCandidate[]>([])
  const [sourceCount, setSourceCount] = useState(0)
  const [sourceErrors, setSourceErrors] = useState<string[]>([])
  const [fastestUrl, setFastestUrl] = useState<string | undefined>()

  const updateProxyUrl = (value: string) => {
    setSettings((current) => ({ ...current, outbound_proxy_url: value }))
    setResult(null)
  }

  const testProxy = async () => {
    const proxyUrl = settings.outbound_proxy_url.trim()
    if (!proxyUrl) {
      toast.error('请先填写代理地址')
      return
    }
    setTesting(true)
    setResult(null)
    try {
      const nextResult = await testOutboundProxy(proxyUrl)
      setResult(nextResult)
      if (nextResult.success) {
        toast.success(`代理连通成功（HTTP ${nextResult.status}，${nextResult.latencyMs}ms）`)
      } else {
        toast.error(nextResult.error || '代理测试失败')
      }
    } catch {
      const nextResult = { success: false, error: '代理测试请求失败' }
      setResult(nextResult)
      toast.error(nextResult.error)
    } finally {
      setTesting(false)
    }
  }

  const testCandidate = async (url: string) => {
    setTestingCandidates((current) => ({ ...current, [url]: true }))
    try {
      const nextResult = await testOutboundProxy(url)
      setCandidateResults((current) => ({ ...current, [url]: nextResult }))
      if (nextResult.success) toast.success(`节点测试成功（${nextResult.latencyMs}ms）`)
      else toast.error(nextResult.error || '节点测试失败')
      return nextResult
    } catch {
      const nextResult = { success: false, error: '节点测试请求失败' }
      setCandidateResults((current) => ({ ...current, [url]: nextResult }))
      toast.error(nextResult.error)
      return nextResult
    } finally {
      setTestingCandidates((current) => ({ ...current, [url]: false }))
    }
  }

  const testAllCandidates = async () => {
    setTestingAll(true)
    setCandidates([])
    setSourceCount(0)
    setCandidateResults({})
    setSourceErrors([])
    setFastestUrl(undefined)
    try {
      const batch = await testAllOutboundProxies()
      setCandidates(batch.results.map(({ url, label }) => ({ url, label })))
      setSourceCount(batch.sourceCount)
      const nextResults = Object.fromEntries(batch.results.map((item) => [item.url, item]))
      setCandidateResults(nextResults)
      setSourceErrors(batch.sourceErrors)
      setFastestUrl(batch.fastestUrl)
      const successCount = batch.results.filter((item) => item.success).length
      if (batch.fastestUrl) {
        const fastest = batch.results.find((item) => item.url === batch.fastestUrl)
        toast.success(`测试完成：${successCount}/${batch.results.length} 个可用，最快 ${fastest?.latencyMs}ms`)
      } else {
        toast.error(batch.results.length > 0
          ? `测试完成：${successCount}/${batch.results.length} 个代理可用，暂无可用节点`
          : '暂未获取到免费代理，请稍后刷新重试')
      }
    } catch {
      toast.error('批量代理测试请求失败')
    } finally {
      setTestingAll(false)
    }
  }

  const anyCandidateTesting = useMemo(
    () => Object.values(testingCandidates).some(Boolean),
    [testingCandidates],
  )

  if (sensitiveStatus !== 'ready') {
    return (
      <div className="space-y-2 pt-2">
        <Card className="py-0">
          <CardContent className="flex items-center justify-between gap-3 p-3 text-xs">
            <span className="text-muted-foreground">
              {sensitiveStatus === 'error' ? '代理配置读取失败，已锁定编辑，避免覆盖已有配置。' : '正在安全读取代理配置，暂不可编辑。'}
            </span>
            {sensitiveStatus === 'error' && (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onRetrySensitive}>
                重试
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-2 pt-2">
      <Card className="py-0">
        <CardContent className="space-y-3 p-3">
          <div className="flex items-center gap-2 border-b pb-2">
            <Globe2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">全局出站代理</span>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="outbound-proxy-url" className="text-xs">代理地址</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="outbound-proxy-url"
                type="url"
                value={settings.outbound_proxy_url}
                onChange={(event) => updateProxyUrl(event.target.value)}
                className="h-8 flex-1 font-mono text-xs"
                placeholder="http://用户名:密码@主机:端口"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0 gap-1.5 px-3 text-xs"
                disabled={testing || !settings.outbound_proxy_url.trim()}
                onClick={() => void testProxy()}
              >
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {testing ? '测试中...' : '测试连通性'}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              保存后统一用于项目共享 HTTP 层的来源抓取、AI、模型列表和 Webhook；留空表示直连。支持 HTTP/HTTPS 代理及认证信息。
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs">免费代理候选{sourceCount > 0 ? `（${sourceCount} 个来源）` : ''}</Label>
              <div className="flex items-center gap-1.5">
                {fastestUrl && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 px-2 text-[11px]"
                    disabled={testingAll || anyCandidateTesting}
                    onClick={() => updateProxyUrl(fastestUrl)}
                  >
                    <Zap className="h-3 w-3" />
                    使用最快
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 px-2 text-[11px]"
                  disabled={testingAll || anyCandidateTesting || testing}
                  onClick={() => void testAllCandidates()}
                >
                  {testingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                  {testingAll ? '获取并测速中...' : '获取并测速全部'}
                </Button>
              </div>
            </div>

            <div className="grid gap-1.5 sm:grid-cols-2">
              {candidates.map((candidate) => {
                const candidateResult = candidateResults[candidate.url]
                const candidateTesting = testingCandidates[candidate.url] === true
                const isFastest = fastestUrl === candidate.url
                return (
                  <div key={candidate.url} className={`flex min-w-0 items-center gap-2 border px-2 py-1.5 text-xs ${isFastest ? 'border-amber-300 bg-amber-50/60' : 'bg-background'}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{candidate.label}</span>
                        {isFastest && <span className="text-[10px] font-medium text-amber-700">最快</span>}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground" title={candidate.url}>{candidate.url}</div>
                      <div className="flex min-h-4 items-center gap-1 text-[11px]">
                        {candidateTesting ? (
                          <span className="text-muted-foreground"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />测试中</span>
                        ) : candidateResult?.success ? (
                          <span className="text-emerald-700"><Clock3 className="mr-1 inline h-3 w-3" />{candidateResult.latencyMs}ms · HTTP {candidateResult.status}</span>
                        ) : candidateResult ? (
                          <span className="truncate text-red-700" title={candidateResult.error}>{candidateResult.error || '不可用'}</span>
                        ) : (
                          <span className="text-muted-foreground">未测试</span>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 px-1.5 text-[11px]"
                      disabled={testingAll || anyCandidateTesting || testing}
                      onClick={() => updateProxyUrl(candidate.url)}
                    >
                      使用
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 px-1.5 text-[11px]"
                      disabled={testingAll || anyCandidateTesting || testing}
                      onClick={() => void testCandidate(candidate.url)}
                    >
                      测试
                    </Button>
                  </div>
                )
              })}
            </div>
            {candidates.length === 0 && !testingAll && (
              <p className="border border-dashed px-2 py-2 text-[11px] text-muted-foreground">
                点击“获取并测速全部”获取公开列表中的最新候选节点。
              </p>
            )}
            {sourceErrors.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                部分列表源暂不可用：{sourceErrors.join('、')}；已继续使用其他来源。
              </p>
            )}
            <p className="text-[11px] text-amber-700">
              免费节点来自实时公开列表，可能随时失效或被拦截。测试完成后可点击“使用最快”，再保存；不要用于传输敏感数据。
            </p>
          </div>

          {result && (
            <div className={`flex items-center gap-1.5 border px-2 py-1.5 text-xs ${result.success ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
              {result.success ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <XCircle className="h-3.5 w-3.5 shrink-0" />}
              <span>
                {result.success
                  ? `已通过代理访问赢商网（HTTP ${result.status}，${result.latencyMs}ms）`
                  : result.error || '代理测试失败'}
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
