'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
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
  Loader2,
  Trash2,
  FileText,
  Database,
  RefreshCcw,
  Shrink,
  Download,
  FileUp,
} from 'lucide-react'
import { toast } from 'sonner'
import { parseSettingsImport } from '@/lib/settings-import'
import {
  executeMaintenanceAction,
  fetchCleanupStats as loadCleanupStats,
  type MaintenanceAction,
} from '@/features/maintenance-api.client'
import { exportSettings, saveSettings } from '@/features/settings-api.client'

export default function DataTab() {
  const [cleanupStats, setCleanupStats] = useState<Record<string, number> | null>(null)
  const [cleanupLoading, setCleanupLoading] = useState<string | null>(null)
  const [refreshingStats, setRefreshingStats] = useState(false)
  const [deleteAllOpen, setDeleteAllOpen] = useState(false)
  const [deleteAllLoading, setDeleteAllLoading] = useState(false)
  const [purgeAllOpen, setPurgeAllOpen] = useState(false)
  const [purgeAllLoading, setPurgeAllLoading] = useState(false)
  const [dbSize, setDbSize] = useState<number | null>(null)
  const [vacuuming, setVacuuming] = useState(false)

  // 配置导入/导出
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [pendingImport, setPendingImport] = useState<Record<string, string> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleExport = async () => {
    setExporting(true)
    try {
      const data = await exportSettings()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const now = new Date()
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
      const a = document.createElement('a')
      a.href = url
      a.download = `hot2-settings-${stamp}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('配置已导出')
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) {
        toast.warning('未授权导出，请先在「账户」标签页填写 API Token')
      } else {
        toast.error('导出失败')
      }
    } finally {
      setExporting(false)
    }
  }

  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许再次选同一文件
    if (!file) return
    // 防 DoS:配置导出文件 < 10KB,1MB 已是极宽松上限。
    if (file.size > 1_000_000) {
      toast.error('文件过大(>1MB),请确认是否为合法配置导出')
      return
    }
    const text = await file.text()
    const parsed = parseSettingsImport(text)
    if (!parsed.ok) {
      toast.error(parsed.error)
      return
    }
    // 文件合法但没有任何匹配的可写键(版本/类型/字段名漂移),避免误导
    // toast + 无意义 reload。
    if (Object.keys(parsed.settings).length === 0) {
      toast.error('文件中没有可识别的配置项,可能不是本应用的配置')
      return
    }
    setPendingImport(parsed.settings)
    setImportOpen(true)
  }

  const executeImport = async () => {
    if (!pendingImport) return
    setImporting(true)
    try {
      await saveSettings(pendingImport)
      toast.success('配置已导入，页面即将刷新')
      setImportOpen(false)
      setTimeout(() => window.location.reload(), 600)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const loadAllCleanupStats = useCallback(async () => {
    setRefreshingStats(true)
    try {
      const data = await loadCleanupStats()
      setCleanupStats(data as unknown as Record<string, number>)
      if (typeof data.dbSizeBytes === 'number') setDbSize(data.dbSizeBytes)
    } catch (err) {
      toast.error('清理统计加载失败')
      console.error('[data-tab] fetchCleanupStats failed:', err)
    } finally {
      setRefreshingStats(false)
    }
  }, [])

  useEffect(() => {
    const handle = setTimeout(loadAllCleanupStats, 0)
    return () => clearTimeout(handle)
  }, [loadAllCleanupStats])

  const executeCleanup = async (action: string, label: string) => {
    setCleanupLoading(action)
    try {
      const result = (await executeMaintenanceAction(action as MaintenanceAction)) as {
        deleted?: number;
        reset?: number;
      }
      const count = result.deleted ?? result.reset ?? 0
      toast.success(`${label}完成，共处理 ${count} 条`)
      loadAllCleanupStats()
    } catch {
      toast.error(`${label}失败`)
    } finally {
      setCleanupLoading(null)
    }
  }

  const handleDeleteLowQuality = async () => {
    setCleanupLoading('low-quality')
    try {
      const result = await executeMaintenanceAction('low-quality') as { deleted?: number }
      toast.success(`已删除 ${result.deleted} 篇低质量文章`)
      loadAllCleanupStats()
    } catch {
      toast.error('清理失败')
    } finally {
      setCleanupLoading(null)
    }
  }

  const executeDeleteAllArticles = async () => {
    setDeleteAllLoading(true)
    try {
      const data = (await executeMaintenanceAction('all-articles')) as { deleted?: number }
      toast.success(`已删除 ${data.deleted} 篇文章`)
      loadAllCleanupStats()
    } catch {
      toast.error('删除失败')
    } finally {
      setDeleteAllLoading(false)
      setDeleteAllOpen(false)
    }
  }

  const handleVacuum = async () => {
    setVacuuming(true)
    try {
      const data = (await executeMaintenanceAction('vacuum')) as {
        sizeBefore: number;
        sizeAfter: number;
        saved: number;
      }
      const mbBefore = (data.sizeBefore / 1024 / 1024).toFixed(1)
      const mbAfter = (data.sizeAfter / 1024 / 1024).toFixed(1)
      const mbSaved = (data.saved / 1024 / 1024).toFixed(1)
      toast.success(`数据库已压缩: ${mbBefore} MB → ${mbAfter} MB，释放 ${mbSaved} MB`)
      loadAllCleanupStats()
    } catch {
      toast.error('数据库压缩失败')
    } finally {
      setVacuuming(false)
    }
  }

  const formatDbSize = (bytes: number | null): string => {
    if (bytes == null) return '—'
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const executePurgeAll = async () => {
    setPurgeAllLoading(true)
    try {
      const data = (await executeMaintenanceAction('purge-all')) as { deleted: Record<string, number> }
      const counts = data.deleted
      const total = Object.values(counts).reduce((a, b) => a + b, 0)
      toast.success(`已清空所有业务数据，共 ${total} 条`)
      loadAllCleanupStats()
    } catch {
      toast.error('清空失败')
    } finally {
      setPurgeAllLoading(false)
      setPurgeAllOpen(false)
    }
  }

  return (
    <div className="space-y-2 pt-2">
      {/* 配置导入/导出 */}
      <Card className="py-0">
        <CardContent className="space-y-2 p-3">
          <div className="border-b pb-2 text-sm font-semibold">配置导入/导出</div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={handleExport} disabled={exporting} className="h-7 gap-1.5 px-2.5 text-xs">
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              导出配置
            </Button>
            <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={importing} className="h-7 gap-1.5 px-2.5 text-xs">
              {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}
              导入配置
            </Button>
            <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleFilePicked} className="hidden" />
          </div>
          <p className="text-xs text-destructive">⚠️ 导出文件含明文 API 密钥，请勿外传。导入将覆盖当前配置。</p>
        </CardContent>
      </Card>

      {/* 数据清理 */}
      <Card className="py-0">
        <CardContent className="space-y-2.5 p-3">
          <div className="flex items-center justify-between border-b pb-2">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">数据清理</span>
            </div>
            <div className="flex items-center gap-3">
              {cleanupStats && <span className="text-xs text-muted-foreground">{cleanupStats.articlesTotal} 篇文章</span>}
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1.5" onClick={loadAllCleanupStats} disabled={refreshingStats}>
                <RefreshCcw className={`h-3.5 w-3.5 ${refreshingStats ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </div>
          </div>

          {/* 文章数据 */}
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" />
              文章
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              <CleanupButton loading={cleanupLoading === 'low-quality'} onClick={handleDeleteLowQuality} label="低质量文章" count={cleanupStats ? cleanupStats.articlesLowQuality : null} unit="篇" />
              <CleanupButton loading={cleanupLoading === 'pushed-articles'} onClick={() => executeCleanup('pushed-articles', '清理已推送文章')} label="已推送文章" count={cleanupStats ? cleanupStats.articlesPushed : null} unit="篇" />
              <CleanupButton loading={cleanupLoading === 'reset-ai'} onClick={() => executeCleanup('reset-ai', '重置AI状态')} label="重置AI状态" icon={<RefreshCcw className="h-3.5 w-3.5" />} customLabel={cleanupStats ? `${cleanupStats.articlesTotal - cleanupStats.articlesPending} 篇已处理` : null} />
            </div>
          </div>

          {/* 日志数据 */}
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Database className="h-3.5 w-3.5" />
              日志
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              <CleanupButton loading={cleanupLoading === 'dedup-logs'} onClick={() => executeCleanup('dedup-logs', '清理去重日志')} label="去重日志" count={cleanupStats ? cleanupStats.dedupLogs : null} unit="条" />
              <CleanupButton loading={cleanupLoading === 'fetch-logs'} onClick={() => executeCleanup('fetch-logs', '清理抓取日志')} label="抓取日志" count={cleanupStats ? cleanupStats.fetchLogs : null} unit="条" />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-dashed">
            <Button size="sm" variant="outline" disabled={vacuuming} onClick={handleVacuum} className="h-7 shrink-0 gap-1.5 px-2.5 text-xs">
              {vacuuming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shrink className="h-3.5 w-3.5" />}
              压缩数据库
            </Button>
            <span className="text-xs text-muted-foreground">当前 {formatDbSize(dbSize)}（清理后需压缩才释放磁盘空间）</span>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-dashed">
            <Button size="sm" variant="destructive" disabled={deleteAllLoading} onClick={() => setDeleteAllOpen(true)} className="h-7 shrink-0 gap-1.5 px-2.5 text-xs">
              {deleteAllLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              删除所有文章
            </Button>
            <span className="text-xs text-muted-foreground">{cleanupStats ? `${cleanupStats.articlesTotal} 篇` : '—'}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-dashed">
            <Button size="sm" variant="destructive" disabled={purgeAllLoading} onClick={() => setPurgeAllOpen(true)} className="h-7 shrink-0 gap-1.5 px-2.5 text-xs">
              {purgeAllLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              一键清空所有数据
            </Button>
            <span className="text-xs text-muted-foreground">
              {cleanupStats ? `${(cleanupStats.articlesTotal ?? 0) + (cleanupStats.discardedTotal ?? 0) + (cleanupStats.fetchLogs ?? 0) + (cleanupStats.pushLogs ?? 0) + (cleanupStats.jobsTotal ?? 0)} 条` : '—'}
            </span>
          </div>

          <p className="text-xs text-muted-foreground pt-1">⚠️ 危险操作不可撤销，建议先备份数据库。</p>
        </CardContent>
      </Card>

      {/* 删除全部文章二次确认 */}
      <AlertDialog open={deleteAllOpen} onOpenChange={setDeleteAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除全部文章？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作不可撤销，将删除数据库中所有文章及其推送日志。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={executeDeleteAllArticles}
              disabled={deleteAllLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteAllLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 一键清空二次确认 */}
      <AlertDialog open={purgeAllOpen} onOpenChange={setPurgeAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认清空所有业务数据？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除所有文章、推送日志、未入库记录、抓取日志和任务历史。
              数据源、关键词和设置将被保留。
              此操作不可撤销，建议先备份数据库。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={executePurgeAll}
              disabled={purgeAllLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {purgeAllLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              确认清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 导入配置二次确认 */}
      <AlertDialog open={importOpen} onOpenChange={setImportOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认导入配置？</AlertDialogTitle>
            <AlertDialogDescription>
              将用文件中的参数覆盖当前配置（AI 模型、提示词、推送、调度、去重等）。
              文件中未包含的参数保持不变。导入后页面将自动刷新。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={executeImport} disabled={importing}>
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              确认导入
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function CleanupButton({ loading, onClick, label, count, unit, icon, customLabel }: {
  loading: boolean
  onClick: () => void
  label: string
  count?: number | null
  unit?: string
  icon?: React.ReactNode
  customLabel?: string | null
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={loading}
        onClick={onClick}
        className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (icon ?? <Trash2 className="h-3.5 w-3.5" />)}
        {label}
      </Button>
      <span className="text-xs text-muted-foreground">
        {customLabel ?? (count != null ? `${count} ${unit ?? ''}` : '—')}
      </span>
    </div>
  )
}
