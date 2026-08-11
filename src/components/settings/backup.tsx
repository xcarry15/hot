'use client'

import { useRef, useState } from 'react'
import { DatabaseBackup, Download, FileUp, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  PROJECT_BACKUP_TYPE,
  PROJECT_BACKUP_VERSION,
  summarizeProjectBackup,
  type ProjectBackupPayload,
} from '@/contracts/backup'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { downloadBlob, dateStamp, formatChinaTime } from '@/lib/browser-utils'
import { exportProjectBackup, restoreProjectBackup } from '@/features/backup-api.client'
import KeywordExportCard from './keyword-export'
import DataExportPanel from './data-export'

const MAX_BACKUP_BYTES = 50_000_000

function isProjectBackupPayload(value: unknown): value is ProjectBackupPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<ProjectBackupPayload>
  return record.type === PROJECT_BACKUP_TYPE
    && record.version === PROJECT_BACKUP_VERSION
    && typeof record.settings === 'object'
    && record.settings !== null
    && !Array.isArray(record.settings)
    && Array.isArray(record.promptVersions)
    && Array.isArray(record.sources)
    && Boolean(record.keywords && Array.isArray(record.keywords.entries) && Array.isArray(record.keywords.candidates))
    && Boolean(record.toolDirectory && Array.isArray(record.toolDirectory.categories) && Array.isArray(record.toolDirectory.tools))
    && typeof record.exportedAt === 'string'
}

function validateSourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export default function BackupTab() {
  const [backupBusy, setBackupBusy] = useState<'export' | 'restore' | null>(null)
  const [pendingBackup, setPendingBackup] = useState<ProjectBackupPayload | null>(null)
  const backupInputRef = useRef<HTMLInputElement>(null)

  const handleBackupExport = async () => {
    setBackupBusy('export')
    try {
      const payload = await exportProjectBackup()
      downloadBlob(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
        `开发选址助手-完整备份-${dateStamp()}.json`,
      )
      toast.success('完整备份已下载')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出完整备份失败')
    } finally {
      setBackupBusy(null)
    }
  }

  const handleBackupSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_BACKUP_BYTES) {
      toast.error('备份文件过大，最大支持 50MB')
      return
    }
    try {
      const payload: unknown = JSON.parse(await file.text())
      if (!isProjectBackupPayload(payload)) throw new Error('不是当前项目的完整备份文件')
      
      // 验证数据源 URL 格式
      const invalidUrls = payload.sources.filter(source => !validateSourceUrl(source.url))
      if (invalidUrls.length > 0) {
        throw new Error(`备份中包含 ${invalidUrls.length} 个无效的数据源 URL`)
      }
      
      setPendingBackup(payload)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '备份文件不是有效的 JSON')
    }
  }

  const handleBackupRestore = async () => {
    if (!pendingBackup) return
    setBackupBusy('restore')
    try {
      const result = await restoreProjectBackup(pendingBackup)
      const summary = result.summary
      toast.success(`已恢复 ${summary.sources} 个数据源、${summary.keywords} 个关键词和 ${summary.tools} 个工具`)
      setPendingBackup(null)
      setTimeout(() => window.location.reload(), 600)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '恢复完整备份失败')
    } finally {
      setBackupBusy(null)
    }
  }

  const pendingSummary = pendingBackup ? summarizeProjectBackup(pendingBackup) : null

  return (
    <div className="space-y-2 pt-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Card className="py-0">
          <CardContent className="space-y-3 p-3">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <DatabaseBackup className="h-4 w-4 text-muted-foreground" />
                  完整配置备份
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  导出或恢复设置、提示词、数据源、关键词与工具目录。
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" disabled={backupBusy !== null} onClick={() => void handleBackupExport()}>
                  {backupBusy === 'export' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  下载备份
                </Button>
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" disabled={backupBusy !== null} onClick={() => backupInputRef.current?.click()}>
                  <FileUp className="h-3.5 w-3.5" />
                  上传恢复
                </Button>
                <input ref={backupInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void handleBackupSelected(event)} />
              </div>
            </div>
          </CardContent>
        </Card>

        <KeywordExportCard />
      </div>

      <DataExportPanel />

      <AlertDialog open={pendingBackup !== null} onOpenChange={(open) => { if (!open && backupBusy !== 'restore') setPendingBackup(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认恢复完整备份？</AlertDialogTitle>
            <AlertDialogDescription>
              将覆盖全部可编辑配置；文章与日志不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingSummary && (
            <>
              <div className="grid grid-cols-2 gap-1 py-2 text-xs tabular-nums text-muted-foreground sm:grid-cols-3">
                <span>{pendingSummary.settings} 项设置</span>
                <span>{pendingSummary.promptVersions} 个提示词版本</span>
                <span>{pendingSummary.sources} 个数据源</span>
                <span>{pendingSummary.keywords} 个关键词</span>
                <span>{pendingSummary.keywordCandidates} 个候选词</span>
                <span>{pendingSummary.tools} 个工具</span>
              </div>
              <div className="rounded-md bg-destructive/10 p-3 text-xs">
                <p className="font-semibold text-destructive">⚠️ 警告：此操作不可撤销</p>
                <p className="mt-1 text-muted-foreground">备份导出时间：{formatChinaTime(pendingBackup!.exportedAt)}</p>
              </div>
            </>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={backupBusy === 'restore'}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={backupBusy === 'restore'}
              onClick={(event) => {
                event.preventDefault()
                void handleBackupRestore()
              }}
            >
              {backupBusy === 'restore' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {backupBusy === 'restore' ? '恢复中…' : '确认覆盖恢复'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
