'use client'

import { useState, useEffect } from 'react'
import { useTheme } from '@/components/theme-provider'
import {
  Activity,
  Newspaper,
  Settings,
  Sun,
  Moon,
} from 'lucide-react'
import ArticlesTab from '@/components/articles-tab'
import CrawlLogTab from '@/components/crawl-log-tab'
import SettingsTab from '@/components/settings-tab'
import { URL_PARAM_DETAIL, URL_PARAM_TAB } from '@/components/crawl-log/constants'

type TabKey = 'articles' | 'crawl-log' | 'settings'

interface NavItem {
  key: TabKey
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
}

const navItems: NavItem[] = [
  { key: 'articles', label: '文章流', icon: Newspaper },
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

export default function Home() {
  // 服务端与客户端首帧必须保持一致，避免直接读取 window.location 导致 Hydration mismatch。
  const [activeTab, setActiveTab] = useState<TabKey>('articles')
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  // 等客户端挂载后再渲染主题相关 UI，避免 hydration mismatch
  useEffect(() => {
    setMounted(true)
    setActiveTab(readInitialTab())
  }, [])

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
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
        return <ArticlesTab />
      case 'crawl-log':
        return <CrawlLogTab />
      case 'settings':
        return <SettingsTab />
    }
  }

  return (
    <div className="h-[100dvh] flex flex-col bg-background">
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Sidebar — desktop */}
        <aside className="hidden sm:flex w-[216px] border-r border-border/70 bg-background flex-col shrink-0">
          {/* Logo area */}
          <div className="px-4 py-3.5 flex items-center gap-2.5 border-b border-border/70">
            <div className="w-8 h-8 rounded-[6px] bg-primary flex items-center justify-center shrink-0 overflow-hidden shadow-[0_0_0_1px_rgba(0,0,0,0.08)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
              <img src="/icon-192x192.png" alt="logo" className="w-full h-full object-cover" />
            </div>
            <div className="min-w-0">
              <h1 className="text-[13px] font-semibold leading-5 tracking-tight truncate">新闻聚合</h1>
              <p className="text-[11px] leading-4 text-muted-foreground">推送器</p>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-3 py-4" aria-label="主导航">
            <div className="space-y-1">
              {navItems.map((item) => {
                const isActive = activeTab === item.key
                return (
                  <button
                    key={item.key}
                    onClick={() => handleTabChange(item.key)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`
                      relative w-full flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors duration-150
                      focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring
                      ${isActive
                        ? 'bg-muted text-foreground before:absolute before:left-0 before:top-2 before:h-6 before:w-0.5 before:rounded-full before:bg-foreground'
                        : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                      }
                    `}
                  >
                    <item.icon className="h-[17px] w-[17px] shrink-0" strokeWidth={1.8} />
                    <span>{item.label}</span>
                  </button>
                )
              })}
            </div>
          </nav>

          {/* Sidebar footer */}
          <div className="px-3 py-3 border-t border-border/70">
            {mounted ? (
              <button
                onClick={toggleTheme}
                className="w-full flex h-9 items-center gap-2 rounded-md px-3 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                aria-label="切换主题"
              >
                {resolvedTheme === 'dark' ? (
                  <Sun className="h-[15px] w-[15px] shrink-0" strokeWidth={1.8} />
                ) : (
                  <Moon className="h-[15px] w-[15px] shrink-0" strokeWidth={1.8} />
                )}
                <span>{resolvedTheme === 'dark' ? '亮色模式' : '暗色模式'}</span>
              </button>
            ) : (
              <div className="w-full h-9" />
            )}
            <p className="mt-2 px-3 font-mono text-[10px] tracking-[0.08em] text-muted-foreground/70">v1.0.0</p>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col overflow-hidden min-h-0 bg-background">
          {/* Content area — with bottom padding on mobile for tab bar */}
          <div className="flex-1 overflow-hidden min-h-0 pb-16 sm:pb-0">
            {renderContent()}
          </div>
        </main>
      </div>

      {/* Bottom Tab Bar — mobile only */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur border-t flex items-center justify-around h-16 pb-[env(safe-area-inset-bottom)]">
        {navItems.map((item) => {
          const isActive = activeTab === item.key
          return (
            <button
              key={item.key}
              onClick={() => handleTabChange(item.key)}
              aria-current={isActive ? 'page' : undefined}
              className={`
                flex flex-col items-center justify-center gap-1 flex-1 h-full transition-colors
                ${isActive
                  ? 'text-primary'
                  : 'text-muted-foreground'
                }
              `}
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
