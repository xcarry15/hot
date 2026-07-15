'use client'

import { useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

export default function AdminLoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const nextPath = (() => {
    const next = searchParams.get('next') || '/admin'
    return next.startsWith('/admin') ? next : '/admin'
  })()

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = token.trim()
    if (!value) {
      setError('请输入 API Token')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch('/api/admin-auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: value }),
      })
      const body = await response.json().catch(() => null) as { error?: string } | null
      if (!response.ok) throw new Error(body?.error || '后台授权失败')
      router.replace(nextPath)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '后台授权失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-muted/20 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" /> 后台访问验证
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">请输入服务端配置的 API Token。验证后使用 HttpOnly Cookie 访问后台。</p>
            {searchParams.get('error') === 'config' && <p className="text-sm text-destructive">服务端尚未配置 API_TOKEN。</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="API Token"
              autoComplete="current-password"
              disabled={submitting}
            />
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? '验证中…' : '进入后台'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
