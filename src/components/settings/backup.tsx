'use client'

import { useRef, useState } from 'react'
import { DatabaseBackup, Download, FileSpreadsheet, FileUp, Loader2, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import {
  PROJECT_BACKUP_TYPE,
  PROJECT_BACKUP_VERSION,
  summarizeProjectBackup,
  type ProjectBackupPayload,
} from '@/contracts/backup'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
import DataExportPanel from '@/components/settings/data-export'
import { exportProjectBackup, restoreProjectBackup } from '@/features/backup-api.client'
import { exportKeywordsXlsxBlob, importKeywordsXlsx } from '@/features/keywords-api.client'
import { decryptProjectBackup, encryptProjectBackup } from '@/features/project-backup-crypto.client'

const MAX_BACKUP_BYTES = 50_000_000

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '')
}

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
}

export default function BackupTab() {
  const [backupBusy, setBackupBusy] = useState<'export' | 'restore' | null>(null)
  const [keywordBusy, setKeywordBusy] = useState<'export' | 'import' | null>(null)
  const [pendingBackup, setPendingBackup] = useState<ProjectBackupPayload | null>(null)
  const [backupPassphrase, setBackupPassphrase] = useState('')
  const [backupPassphraseConfirm, setBackupPassphraseConfirm] = useState('')
  const backupInputRef = useRef<HTMLInputElement>(null)
  const keywordInputRef = useRef<HTMLInputElement>(null)

  const handleBackupExport = async () => {
    setBackupBusy('export')
    try {
      if (backupPassphrase !== backupPassphraseConfirm) throw new Error('两次输入的备份保护密码不一致')
      if (backupPassphrase.length < 12 || !backupPassphrase.trim()) throw new Error('备份保护密码至少需要 12 个字符')
      const payload = await exportProjectBackup()
      const encrypted = await encryptProjectBackup(payload, backupPassphrase)
      downloadBlob(
        new Blob([JSON.stringify(encrypted, null, 2)], { type: 'application/json' }),
        `开发选址助手-完整备份-${dateStamp()}.json`,
      )
      toast.success('加密完整备份已下载')
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
      const encrypted: unknown = JSON.parse(await file.text())
      const payload = await decryptProjectBackup(encrypted, backupPassphrase)
      if (!isProjectBackupPayload(payload)) throw new Error('不是当前项目的完整备份文件')
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

  const handleKeywordExport = async () => {
    setKeywordBusy('export')
    try {
      downloadBlob(await exportKeywordsXlsxBlob(), `关键词表格-${dateStamp()}.xlsx`)
      toast.success('关键词表格已导出')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出关键词表格失败')
    } finally {
      setKeywordBusy(null)
    }
  }

  const handleKeywordImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setKeywordBusy('import')
    try {
      const result = await importKeywordsXlsx(file)
      toast.success(`已导入 ${result.imported} 个关键词，候选词状态已同步`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入失败，请检查 XLSX 工作簿格式')
    } finally {
      setKeywordBusy(null)
    }
  }

  const pendingSummary = pendingBackup ? summarizeProjectBackup(pendingBackup) : null

  return (
    <div className="space-y-2 pt-2">
      <Card className="py-0">
        <CardContent className="space-y-3 p-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <DatabaseBackup className="h-4 w-4 text-muted-foreground" />
                完整配置备份
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                加密 JSON 统一保存设置、提示词版本、数据源、关键词与候选词、工具目录；恢复时整体覆盖这些配置。
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" disabled={backupBusy !== null} onClick={() => void handleBackupExport()}>
                {backupBusy === 'export' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                下载加密备份
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" disabled={backupBusy !== null} onClick={() => backupInputRef.current?.click()}>
                <FileUp className="h-3.5 w-3.5" />
                上传恢复
              </Button>
              <input ref={backupInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void handleBackupSelected(event)} />
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              type="password"
              value={backupPassphrase}
              onChange={(event) => setBackupPassphrase(event.target.value)}
              placeholder="备份保护密码（至少 12 位）"
              autoComplete="new-password"
              minLength={12}
              disabled={backupBusy !== null}
            />
            <Input
              type="password"
              value={backupPassphraseConfirm}
              onChange={(event) => setBackupPassphraseConfirm(event.target.value)}
              placeholder="确认备份保护密码（下载时校验）"
              autoComplete="new-password"
              minLength={12}
              disabled={backupBusy !== null}
            />
          </div>
          <div className="flex gap-2 border-t pt-2 text-xs text-amber-700">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>备份内的 API 密钥和 Webhook 已由保护密码加密；忘记密码无法恢复。不包含文章正文、运行日志和任务历史。</p>
          </div>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
              关键词表格
            </div>
            <p className="mt-1 text-xs text-muted-foreground">用于批量编辑关键词和候选词；候选词状态由工作表名称表达，完整备份时无需额外导出。</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" disabled={keywordBusy !== null} onClick={() => void handleKeywordExport()}>
              {keywordBusy === 'export' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              导出 XLSX
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" disabled={keywordBusy !== null} onClick={() => keywordInputRef.current?.click()}>
              {keywordBusy === 'import' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}
              导入 XLSX
            </Button>
            <input ref={keywordInputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(event) => void handleKeywordImport(event)} />
          </div>
        </CardContent>
      </Card>

      <DataExportPanel />

      <AlertDialog open={pendingBackup !== null} onOpenChange={(open) => { if (!open && backupBusy !== 'restore') setPendingBackup(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认恢复完整备份？</AlertDialogTitle>
            <AlertDialogDescription>
              将覆盖当前全部可编辑设置、提示词版本、数据源配置、关键词状态和工具目录。文章与日志不会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingSummary && (
            <div className="grid grid-cols-2 gap-1 border-y py-2 text-xs text-muted-foreground sm:grid-cols-3">
              <span>{pendingSummary.settings} 项设置</span>
              <span>{pendingSummary.promptVersions} 个提示词版本</span>
              <span>{pendingSummary.sources} 个数据源</span>
              <span>{pendingSummary.keywords} 个关键词</span>
              <span>{pendingSummary.keywordCandidates} 个候选词</span>
              <span>{pendingSummary.tools} 个工具</span>
            </div>
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
