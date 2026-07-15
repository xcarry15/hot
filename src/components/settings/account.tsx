'use client'

import { useState } from 'react'
import { LogOut, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { logoutAdminSession } from '@/features/admin-auth.client'

export default function AccountTab() {
  const [loggingOut, setLoggingOut] = useState(false)

  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      await logoutAdminSession()
      window.location.assign('/admin/login')
    } catch {
      toast.error('退出后台失败')
      setLoggingOut(false)
    }
  }

  return (
    <Card className="py-0">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          <div>
            <h3 className="text-sm font-semibold">后台访问已授权</h3>
            <p className="mt-1 text-xs text-muted-foreground">当前使用 HttpOnly Cookie 保存临时后台会话，API Token 不写入浏览器 localStorage。</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={handleLogout} disabled={loggingOut} className="gap-1.5">
          <LogOut className="h-4 w-4" />
          {loggingOut ? '退出中…' : '退出后台'}
        </Button>
      </CardContent>
    </Card>
  )
}
