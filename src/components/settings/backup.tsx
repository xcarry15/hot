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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import {
  decryptProjectBackup,
  encryptProjectBackup,
  isEncryptedProjectBackup,
  type EncryptedProjectBackup,
} from '@/features/project-backup-crypto.client'
import KeywordExportCard from './keyword-export'
import DataExportPanel from './data-export'

const MAX_BACKUP_BYTES = 50_000_000
type BackupPasswordMode = 'export' | 'restore'

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
  const [pendingEncryptedBackup, setPendingEncryptedBackup] = useState<EncryptedProjectBackup | null>(null)
  const [passwordMode, setPasswordMode] = useState<BackupPasswordMode | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [passphraseConfirmation, setPassphraseConfirmation] = useState('')
  const backupInputRef = useRef<HTMLInputElement>(null)

  const closePasswordDialog = () => {
    if (backupBusy !== null) return
    setPasswordMode(null)
    setPendingEncryptedBackup(null)
    setPassphrase('')
    setPassphraseConfirmation('')
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
      if (!isEncryptedProjectBackup(encrypted)) throw new Error('不是当前项目的加密备份文件')
      setPendingEncryptedBackup(encrypted)
      setPasswordMode('restore')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '备份文件不是有效的 JSON')
    }
  }

  const handlePasswordSubmit = async () => {
    if (!passwordMode) return
    if (passphrase.length < 12 || !passphrase.trim()) {
      toast.error('备份保护密码至少需要 12 个字符')
      return
    }
    if (passwordMode === 'export' && passphrase !== passphraseConfirmation) {
      toast.error('两次输入的保护密码不一致')
      return
    }

    setBackupBusy(passwordMode)
    try {
      if (passwordMode === 'export') {
        const payload = await exportProjectBackup()
        const encrypted = await encryptProjectBackup(payload, passphrase)
        downloadBlob(
          new Blob([JSON.stringify(encrypted, null, 2)], { type: 'application/json' }),
          `开发选址助手-完整备份-${dateStamp()}.json`,
        )
        toast.success('加密备份已下载')
      } else {
        if (!pendingEncryptedBackup) throw new Error('加密备份文件已失效，请重新选择')
        const payload = await decryptProjectBackup(pendingEncryptedBackup, passphrase)
        if (!isProjectBackupPayload(payload)) throw new Error('备份解密成功，但内容格式无效')
        const invalidUrls = payload.sources.filter(source => !validateSourceUrl(source.url))
        if (invalidUrls.length > 0) {
          throw new Error(`备份中包含 ${invalidUrls.length} 个无效的数据源 URL`)
        }
        setPendingBackup(payload)
      }
      setPasswordMode(null)
      setPendingEncryptedBackup(null)
      setPassphrase('')
      setPassphraseConfirmation('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `${passwordMode === 'export' ? '导出' : '解密'}完整备份失败`)
    } finally {
      setBackupBusy(null)
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
                  使用保护密码加密导出或恢复设置、提示词、数据源、关键词与工具目录。
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" disabled={backupBusy !== null || passwordMode !== null} onClick={() => setPasswordMode('export')}>
                  {backupBusy === 'export' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  下载备份
                </Button>
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" disabled={backupBusy !== null || passwordMode !== null} onClick={() => backupInputRef.current?.click()}>
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

      <Dialog open={passwordMode !== null} onOpenChange={(open) => { if (!open) closePasswordDialog() }}>
        <DialogContent showCloseButton={backupBusy === null}>
          <DialogHeader>
            <DialogTitle>{passwordMode === 'export' ? '设置备份保护密码' : '输入备份保护密码'}</DialogTitle>
            <DialogDescription>
              {passwordMode === 'export'
                ? '保护密码至少 12 个字符，仅用于本次备份；密码丢失后无法恢复。'
                : '备份将在浏览器中解密，保护密码不会发送到服务器。'}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void handlePasswordSubmit() }}>
            <div className="space-y-2">
              <Label htmlFor="backup-passphrase">保护密码</Label>
              <Input
                id="backup-passphrase"
                type="password"
                autoComplete={passwordMode === 'export' ? 'new-password' : 'current-password'}
                minLength={12}
                value={passphrase}
                disabled={backupBusy !== null}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </div>
            {passwordMode === 'export' ? (
              <div className="space-y-2">
                <Label htmlFor="backup-passphrase-confirmation">确认保护密码</Label>
                <Input
                  id="backup-passphrase-confirmation"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={passphraseConfirmation}
                  disabled={backupBusy !== null}
                  onChange={(event) => setPassphraseConfirmation(event.target.value)}
                />
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={backupBusy !== null} onClick={closePasswordDialog}>取消</Button>
              <Button type="submit" disabled={backupBusy !== null}>
                {backupBusy !== null ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                {backupBusy === 'export' ? '加密中…' : backupBusy === 'restore' ? '解密中…' : passwordMode === 'export' ? '加密并下载' : '解密备份'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
