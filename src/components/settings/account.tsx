'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Cpu } from 'lucide-react'
import { toast } from 'sonner'
import { getApiToken, setApiToken, clearApiToken } from '@/lib/api-client'

export default function AccountTab() {
  // localStorage-backed; initial value lazy-init 避免 useEffect 同步 setState
  const [apiTokenInput, setApiTokenInput] = useState(() => getApiToken())
  const [apiTokenSaved, setApiTokenSaved] = useState(() => getApiToken())

  // 跨标签同步:另一个标签页修改 localStorage 时自动同步本地 state
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'api_token') return
      const next = e.newValue || ''
      setApiTokenInput(next)
      setApiTokenSaved(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const handleSaveApiToken = () => {
    if (apiTokenInput && apiTokenInput !== apiTokenSaved) {
      setApiToken(apiTokenInput)
      setApiTokenSaved(apiTokenInput)
      toast.success('API Token 已保存到本地（仅当前浏览器）')
    } else if (!apiTokenInput) {
      clearApiToken()
      setApiTokenSaved('')
      toast.success('API Token 已清除')
    } else {
      toast.info('未变化')
    }
  }

  const handleClearApiToken = () => {
    setApiTokenInput('')
    clearApiToken()
    setApiTokenSaved('')
    toast.success('API Token 已清除')
  }

  return (
    <Card className="py-0">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-semibold">API 访问令牌</Label>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          生产部署时服务端会要求写操作（保存设置/触发爬取/删除文章等）携带 <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">Authorization: Bearer &lt;token&gt;</code>。
          填入与服务端 <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">.env</code> 中 <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">API_TOKEN</code> 一致的值。Token 仅保存在当前浏览器 localStorage。
        </p>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={apiTokenInput}
            onChange={(e) => setApiTokenInput(e.target.value)}
            placeholder="留空 = 不发送 token（开发模式可用）"
            className="h-9 text-sm font-mono"
            autoComplete="off"
          />
          <Button size="sm" onClick={handleSaveApiToken} className="h-9 px-4 shrink-0">
            保存
          </Button>
          {apiTokenSaved && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleClearApiToken}
              className="h-9 px-4 shrink-0"
            >
              清除
            </Button>
          )}
        </div>
        {apiTokenSaved && (
          <p className="text-xs text-emerald-600 font-medium">
            ✓ 已保存（{apiTokenSaved.length} 位字符）
          </p>
        )}
      </CardContent>
    </Card>
  )
}
