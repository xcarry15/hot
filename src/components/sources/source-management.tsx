'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { LoadingList } from '@/components/ui/loading-list'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Plus,
  Trash2,
  Edit3,
  RefreshCw,
  Play,
  CheckCircle2,
  XCircle,
  Loader2,
  Power,
  PowerOff,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatRelativeTime } from '@/lib/shared/date'
import { EmptyData, EmptyState } from '@/components/ui/empty-state'
import { StatusLight } from './status-light'
import { DEFAULT_PARSER_CONFIGS } from './constants'
import type { Source, TestResult } from './types'
import {
  batchToggleSources,
  createSource,
  deleteSource as deleteSourceApi,
  fetchSources,
  retrySource,
  testSource,
  updateSource,
} from '@/features/sources-api.client'

// ========== Source Management (CRUD + Test + Batch) ==========

export function SourceManagement() {
  const [sources, setSources] = useState<Source[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editSource, setEditSource] = useState<Source | null>(null)
  const [deleteSource, setDeleteSource] = useState<Source | null>(null)
  const [expandedErrors, setExpandedErrors] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [showTestDialog, setShowTestDialog] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [batchToggling, setBatchToggling] = useState(false)
  const [batchToggleTarget, setBatchToggleTarget] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const loadRequestRef = useRef(0)

  // Form state
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState('html')
  const [formUrl, setFormUrl] = useState('')
  const [formParserConfigs, setFormParserConfigs] = useState<Record<string, string>>({ ...DEFAULT_PARSER_CONFIGS })
  const [formEnabled, setFormEnabled] = useState(true)

  const formParserConfig = formParserConfigs[formType] || DEFAULT_PARSER_CONFIGS[formType] || '{}'

  const loadSources = useCallback(async () => {
    const requestId = ++loadRequestRef.current
    setLoadError(null)
    setLoading(true)
    try {
      const data = await fetchSources()
      if (requestId !== loadRequestRef.current) return
      setSources(data)
    } catch (error) {
      if (requestId !== loadRequestRef.current) return
      const message = error instanceof Error && error.message ? error.message : '获取数据源失败'
      setLoadError(message)
      toast.error(message)
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const handle = setTimeout(loadSources, 0)
    return () => clearTimeout(handle)
  }, [loadSources])

  const resetForm = () => {
    setFormName('')
    setFormType('html')
    setFormUrl('')
    setFormParserConfigs({ ...DEFAULT_PARSER_CONFIGS })
    setFormEnabled(true)
    setTestResult(null)
  }

  const openAddDialog = () => {
    resetForm()
    setEditSource(null)
    setShowAddDialog(true)
  }

  const openEditDialog = (source: Source) => {
    setEditSource(source)
    setFormName(source.name)
    setFormType(source.type)
    setFormUrl(source.url)
    setFormParserConfigs({
      ...DEFAULT_PARSER_CONFIGS,
      [source.type]: source.parserConfig || DEFAULT_PARSER_CONFIGS[source.type] || '{}',
    })
    setFormEnabled(source.enabled)
    setTestResult(null)
    setShowAddDialog(true)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testSource({
        type: formType,
        url: formUrl,
        parserConfig: formParserConfig,
      })
      setTestResult(result)
      if (result.success) {
        toast.success(`测试成功，发现 ${result.items.length} 条内容`)
      } else {
        toast.error(result.error || '测试失败')
      }
    } catch {
      toast.error('测试请求失败')
      setTestResult({ success: false, items: [], error: '请求失败' })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (saving || testing) return
    if (!formName.trim() || !formUrl.trim()) {
      toast.error('名称和URL为必填项')
      return
    }

    setSaving(true)
    try {
      const baseInput = {
        name: formName.trim(),
        type: formType,
        url: formUrl.trim(),
        parserConfig: formParserConfig,
        enabled: formEnabled,
      }
      if (editSource) {
        await updateSource(editSource.id, baseInput)
        toast.success('数据源已更新')
      } else {
        await createSource(baseInput)
        toast.success('数据源已创建')
      }
      setShowAddDialog(false)
      await loadSources()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteSource) return
    try {
      await deleteSourceApi(deleteSource.id)
      toast.success('数据源已删除')
      setDeleteSource(null)
      loadSources()
    } catch {
      toast.error('删除失败')
    }
  }

  const handleToggleEnabled = async (source: Source) => {
    try {
      await updateSource(source.id, { enabled: !source.enabled })
      loadSources()
    } catch {
      toast.error('切换状态失败')
    }
  }

  const handleBatchToggle = async (enabled: boolean) => {
    setBatchToggling(true)
    try {
      const result = await batchToggleSources(enabled)
      toast.success(`已${enabled ? '开启' : '停用'} ${result.updated} 个数据源`)
      loadSources()
    } catch {
      toast.error('批量操作失败')
    } finally {
      setBatchToggling(false)
      setBatchToggleTarget(null)
    }
  }

  const handleRetry = async (sourceId: string) => {
    setRetrying(sourceId)
    try {
      const data = (await retrySource(sourceId)) as { queued?: boolean; error?: string }
      if (data?.queued === false) {
        toast.info(data.error || '已有抓取任务在执行中')
      } else {
        toast.success('重试已加入队列，可在任务中心查看进度')
      }
      loadSources()
    } catch {
      toast.error('重试失败')
    } finally {
      setRetrying(null)
    }
  }

  const filteredSources = sources.filter(s => {
    if (searchQuery && !s.name.toLowerCase().includes(searchQuery.toLowerCase()) && !s.url.toLowerCase().includes(searchQuery.toLowerCase())) return false
    if (statusFilter !== 'all' && s.status !== statusFilter && !(statusFilter === 'disabled' && !s.enabled)) return false
    if (statusFilter === 'disabled' && s.enabled) return false
    return true
  })

  if (loading && sources.length === 0) {
    return <LoadingList count={5} />
  }

  if (loadError && sources.length === 0) {
    return (
      <EmptyState
        title="数据源加载失败"
        description={loadError}
        action={
          <Button size="sm" variant="outline" onClick={() => void loadSources()} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            重新加载
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar */}
      <div className="space-y-1.5 border-b p-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="搜索..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-7 w-40 text-xs"
          />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-7 w-[88px] text-xs">
              <SelectValue placeholder="状态" />
            </SelectTrigger>
            <SelectContent className="rounded-none shadow-sm">
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="normal">正常</SelectItem>
              <SelectItem value="warning">警告</SelectItem>
              <SelectItem value="breaker">熔断</SelectItem>
              <SelectItem value="disabled">禁用</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={openAddDialog} className="h-7 gap-1 px-2.5 text-xs">
            <Plus className="h-3.5 w-3.5" />
            添加
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setBatchToggleTarget(true)}
            disabled={batchToggling || sources.length === 0 || sources.every(s => s.enabled)}
            className="h-7 gap-1 px-2 text-xs"
            title="开启所有数据源"
          >
            {batchToggling && batchToggleTarget === true ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
            全部开启
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setBatchToggleTarget(false)}
            disabled={batchToggling || sources.length === 0 || sources.every(s => !s.enabled)}
            className="h-7 gap-1 px-2 text-xs"
            title="停用所有数据源"
          >
            {batchToggling && batchToggleTarget === false ? <Loader2 className="h-3 w-3 animate-spin" /> : <PowerOff className="h-3 w-3" />}
            全部停用
          </Button>
        </div>
      </div>

      {loadError && sources.length > 0 && (
        <div role="alert" className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          <span>数据源刷新失败，当前显示上次成功读取的结果。</span>
          <Button size="sm" variant="outline" onClick={() => void loadSources()} disabled={loading} className="h-6 shrink-0 px-2 text-[11px]">
            {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            重试
          </Button>
        </div>
      )}

      {/* Source List */}
      <ScrollArea className="flex-1 h-full">
        {filteredSources.length === 0 ? (
          searchQuery || statusFilter !== 'all' ? (
            <EmptyState
              title="没有匹配的数据源"
              description="可以清除搜索或状态筛选后重试。"
              action={
                <Button size="sm" variant="outline" onClick={() => { setSearchQuery(''); setStatusFilter('all') }}>
                  清除筛选
                </Button>
              }
            />
          ) : (
            <EmptyData message="暂无数据源" />
          )
        ) : (
          <div className="space-y-px p-2">
            {filteredSources.map((source) => (
              <div key={source.id} className="flex flex-wrap items-center gap-2 border px-2 py-1 text-xs">
                <button
                  className="shrink-0"
                  onClick={() => setExpandedErrors(expandedErrors === source.id ? null : source.id)}
                  title="点击查看错误"
                >
                  <StatusLight
                    status={source.enabled ? source.status : 'disabled'}
                    lastFetchedAt={source.lastFetchedAt}
                  />
                </button>

                {/* Name & Type */}
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="font-medium truncate">{source.name}</span>
                  <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 shrink-0">{source.type}</Badge>
                </div>

                {/* Stats */}
                <div className="hidden shrink-0 items-center gap-2 text-muted-foreground lg:flex">
                  <span>{source.articleCount}篇</span>
                  <span>{formatRelativeTime(source.lastFetchedAt)}</span>
                  {source.consecutiveFailures > 0 && (
                    <span className="text-red-500">{source.consecutiveFailures}次失败</span>
                  )}
                </div>

                <Switch
                  checked={source.enabled}
                  onCheckedChange={() => handleToggleEnabled(source)}
                  className="scale-75"
                />

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0"
                    onClick={() => {
                      setFormType(source.type)
                      setFormUrl(source.url)
                      setFormParserConfigs({
                        ...DEFAULT_PARSER_CONFIGS,
                        [source.type]: source.parserConfig || DEFAULT_PARSER_CONFIGS[source.type] || '{}',
                      })
                      setTestResult(null)
                      setShowTestDialog(true)
                    }}
                    title="测试抓取"
                  >
                    <Play className="h-3 w-3" />
                  </Button>
                  {source.status === 'breaker' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={() => handleRetry(source.id)}
                      disabled={retrying === source.id}
                      title="立即重试"
                    >
                      <RefreshCw className={`h-3 w-3 ${retrying === source.id ? 'animate-spin' : ''}`} />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0"
                    onClick={() => openEditDialog(source)}
                    title="编辑"
                  >
                    <Edit3 className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                    onClick={() => setDeleteSource(source)}
                    title="删除"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>

                {/* Expanded Errors */}
                {expandedErrors === source.id && source.recentErrors.length > 0 && (
                  <div className="w-full space-y-0.5 border-t pl-6 pt-1.5">
                    {source.recentErrors.map((err, i) => (
                      <div key={i} className="text-[10px] text-red-500 flex items-start gap-1">
                        <XCircle className="h-2.5 w-2.5 shrink-0 mt-0.5" />
                        <span className="truncate flex-1">{err.message}</span>
                        <span className="text-muted-foreground shrink-0">{formatRelativeTime(err.time)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Add/Edit Source Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">{editSource ? '编辑数据源' : '添加数据源'}</DialogTitle>
            <DialogDescription className="sr-only">{editSource ? '编辑数据源配置' : '添加新的数据源'}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-sm">名称 *</Label>
                <Input value={formName} onChange={(e) => setFormName(e.target.value)} className="h-8 text-xs" placeholder="数据源名称" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">类型</Label>
                <Select value={formType} onValueChange={setFormType}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-none shadow-sm">
                    <SelectItem value="html">HTML</SelectItem>
                    <SelectItem value="rss">RSS</SelectItem>
                    <SelectItem value="websearch">网页搜索</SelectItem>
                    <SelectItem value="canyin88">餐饮88</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">URL *</Label>
              <Input value={formUrl} onChange={(e) => setFormUrl(e.target.value)} className="h-8 text-xs" placeholder="https://..." />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">解析配置 (JSON)</Label>
              <Textarea
                value={formParserConfig}
                onChange={(e) => setFormParserConfigs((current) => ({ ...current, [formType]: e.target.value }))}
                className="text-sm font-mono min-h-[120px]"
                placeholder="{}"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={formEnabled} onCheckedChange={setFormEnabled} />
              <Label className="text-sm">启用</Label>
              <span className="text-xs text-muted-foreground ml-auto">
                全局抓取间隔在「设置 → 推送」中配置
              </span>
            </div>

            {/* Test Result */}
            {testResult && (
              <div className={`border p-3 ${testResult.success ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
                <div className="flex items-center gap-1.5 text-sm font-medium mb-2">
                  {testResult.success ? (
                    <><CheckCircle2 className="h-4 w-4 text-emerald-600" /> 测试成功 - {testResult.items.length} 条结果</>
                  ) : (
                    <><XCircle className="h-4 w-4 text-red-600" /> 测试失败</>
                  )}
                </div>
                {testResult.error && <p className="text-sm text-red-600">{testResult.error}</p>}
                {testResult.items.length > 0 && (
                  <div className="mt-1 space-y-1 max-h-32 overflow-y-auto">
                    {testResult.items.map((item, i) => (
                      <div key={i} className="bg-white/60 px-2 py-1 text-sm">
                        <div className="font-medium truncate">{item.title}</div>
                        {item.summary && <div className="text-muted-foreground truncate">{item.summary}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button size="sm" variant="outline" onClick={handleTest} disabled={testing || saving} className="gap-1.5">
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              测试抓取
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving || testing}>
              {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {saving ? '保存中' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Test Dialog (standalone) */}
      <Dialog open={showTestDialog} onOpenChange={setShowTestDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">测试抓取</DialogTitle>
            <DialogDescription className="sr-only">测试数据源抓取</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm">URL</Label>
              <Input value={formUrl} onChange={(e) => setFormUrl(e.target.value)} className="h-8 text-xs" />
            </div>
            <Button size="sm" onClick={async () => {
              setTesting(true)
              setTestResult(null)
              try {
                const result = await testSource({
                  type: formType,
                  url: formUrl,
                  parserConfig: formParserConfig,
                })
                setTestResult(result)
              } catch {
                setTestResult({ success: false, items: [], error: '请求失败' })
              } finally {
                setTesting(false)
              }
            }} disabled={testing} className="gap-1.5">
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              开始测试
            </Button>
            {testResult && (
              <div className={`border p-3 text-sm ${testResult.success ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
                {testResult.success ? (
                  <div className="space-y-1">
                    <div className="font-medium text-emerald-700">发现 {testResult.items.length} 条内容</div>
                    {testResult.items.map((item, i) => (
                      <div key={i} className="truncate bg-white/60 px-2 py-1">{item.title}</div>
                    ))}
                  </div>
                ) : (
                  <div className="text-red-700">{testResult.error || '测试失败'}</div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Batch Toggle Confirmation */}
      <AlertDialog open={batchToggleTarget !== null} onOpenChange={() => setBatchToggleTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              {batchToggleTarget ? '确认开启所有数据源' : '确认停用所有数据源'}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm">
              {batchToggleTarget
                ? `将开启所有数据源（共 ${sources.length} 个），已停用的源也会被重新启用。确定继续吗？`
                : `将停用所有数据源（共 ${sources.length} 个），停用后将停止定时抓取。确定继续吗？`
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleBatchToggle(batchToggleTarget!)}
              className={`text-xs ${!batchToggleTarget ? 'bg-destructive hover:bg-destructive/90' : ''}`}
            >
              {batchToggleTarget ? '确认开启' : '确认停用'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteSource} onOpenChange={() => setDeleteSource(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">确认删除</AlertDialogTitle>
            <AlertDialogDescription className="text-sm">
              确定要删除数据源 &quot;{deleteSource?.name}&quot; 吗？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="text-xs bg-destructive hover:bg-destructive/90">删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
