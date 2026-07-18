import { ShieldCheck } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'

export default function AccountTab() {
  return (
    <Card className="py-0">
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          <div>
            <h3 className="text-sm font-semibold">后台访问已授权</h3>
            <p className="mt-1 text-xs text-muted-foreground">当前使用 HttpOnly Cookie 保存临时后台会话，API Token 不写入浏览器 localStorage。</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
