'use client'

import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { useTheme } from '@/components/theme-provider'
import { Activity, Inbox, LogOut, Settings, Sun, Moon } from 'lucide-react'
import IntelligenceInbox from '@/components/intelligence-inbox'
import CrawlLogTab from '@/components/crawl-log-tab'
import SettingsTab from '@/components/settings-tab'
import { URL_PARAM_DETAIL, URL_PARAM_TAB } from '@/components/crawl-log/constants'
import { logoutAdminSession } from '@/features/admin-auth.client'

type TabKey = 'articles' | 'crawl-log' | 'settings'

interface NavItem {
  key: TabKey
  label: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
}

const navItems: NavItem[] = [
  { key: 'articles', label: '情报收件箱', icon: Inbox },
  { key: 'crawl-log', label: '抓取记录', icon: Activity },
  { key: 'settings', label: '设置', icon: Settings },
]

function readInitialTab(): TabKey {
  if (typeof window === 'undefined') return 'articles'
  const params = new URLSearchParams(window.location.search)
  const tab = params.get(URL_PARAM_TAB)
  if (tab === 'crawl-log' || tab === 'settings' || tab === 'articles') return tab
  return params.has(URL_PARAM_DETAIL) ? 'crawl-log' : 'articles'
}

function AdminContent() {
  const [activeTab, setActiveTab] = useState<TabKey>('articles')
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const router = useRouter()

  useEffect(() => {
    setMounted(true)
    setActiveTab(readInitialTab())
  }, [])

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }

  const handleLogout = async () => {
    await logoutAdminSession()
    router.replace('/admin/login')
  }

  const handleTabChange = (tab: TabKey) => {
    setActiveTab(tab)
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (tab === 'articles') url.searchParams.delete(URL_PARAM_TAB)
    else url.searchParams.set(URL_PARAM_TAB, tab)
    window.history.replaceState(null, '', url.toString())
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'articles':
        return <IntelligenceInbox />
      case 'crawl-log':
        return <CrawlLogTab />
      case 'settings':
        return <SettingsTab />
    }
  }

  return (
    <div className="h-[100dvh] flex flex-col bg-background">
      <div className="flex flex-1 overflow-hidden min-h-0">
        <aside className="hidden sm:flex w-[180px] border-r border-border/70 bg-background flex-col shrink-0">
          <div className="px-3 py-3.5 flex items-center gap-2 border-b border-border/70">
            <div className="w-8 h-8 rounded-[6px] bg-primary flex items-center justify-center shrink-0 overflow-hidden shadow-[0_0_0_1px_rgba(0,0,0,0.08)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
              <img src="/icon-192x192.png" alt="logo" className="w-full h-full object-cover" />
            </div>
            <div className="min-w-0">
              <h1 className="text-[13px] font-semibold leading-5 tracking-tight truncate">新闻聚合</h1>
              <p className="text-[11px] leading-4 text-muted-foreground">管理后台</p>
            </div>
          </div>

          <nav className="flex-1 px-2 py-4" aria-label="后台主导航">
            <div className="space-y-1">
              {navItems.map((item) => {
                const isActive = activeTab === item.key
                return (
                  <button
                    key={item.key}
                    onClick={() => handleTabChange(item.key)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`relative w-full flex h-10 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${isActive ? 'bg-muted text-foreground before:absolute before:left-0 before:top-2 before:h-6 before:w-0.5 before:rounded-full before:bg-foreground' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'}`}
                  >
                    <item.icon className="h-[17px] w-[17px] shrink-0" strokeWidth={1.8} />
                    <span>{item.label}</span>
                  </button>
                )
              })}
            </div>
          </nav>

          <div className="px-2 py-3 border-t border-border/70">
            <button
              onClick={handleLogout}
              className="mb-2 w-full flex h-9 items-center gap-2 rounded-md px-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <LogOut className="h-[15px] w-[15px] shrink-0" strokeWidth={1.8} />
              <span>退出后台</span>
            </button>
            {mounted ? (
              <button
                onClick={toggleTheme}
                className="w-full flex h-9 items-center gap-2 rounded-md px-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                aria-label="切换主题"
              >
                {resolvedTheme === 'dark' ? <Sun className="h-[15px] w-[15px] shrink-0" strokeWidth={1.8} /> : <Moon className="h-[15px] w-[15px] shrink-0" strokeWidth={1.8} />}
                <span>{resolvedTheme === 'dark' ? '亮色模式' : '暗色模式'}</span>
              </button>
            ) : <div className="w-full h-9" />}
            <p className="mt-2 px-2.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground/70">v1.0.0</p>
          </div>
        </aside>

        <main className="flex-1 flex flex-col overflow-hidden min-h-0 bg-background">
          <div className="flex-1 overflow-hidden min-h-0 pb-16 sm:pb-0">{renderContent()}</div>
        </main>
      </div>

      <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur border-t flex items-center justify-around h-16 pb-[env(safe-area-inset-bottom)]">
        {navItems.map((item) => {
          const isActive = activeTab === item.key
          return (
            <button
              key={item.key}
              onClick={() => handleTabChange(item.key)}
              aria-current={isActive ? 'page' : undefined}
              className={`flex flex-col items-center justify-center gap-1 flex-1 h-full transition-colors ${isActive ? 'text-primary' : 'text-muted-foreground'}`}
            >
              <item.icon className="h-5 w-5" />
              <span className="text-[11px] font-medium leading-none">{item.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}

export default function AdminShell() {
  return <AdminContent />
}
