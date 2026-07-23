'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { useTheme } from '@/components/theme-provider'
import { Activity, ExternalLink, Settings, Sun, Moon } from 'lucide-react'
import { URL_PARAM_DETAIL, URL_PARAM_TAB } from '@/components/crawl-log/constants'
import { fetchWorkQueueSummary } from '@/features/work-queue-api.client'
import { APP_VERSION } from '@/contracts/app'

type TabKey = 'crawl-log' | 'settings'

function AdminPageLoading() {
  return <div className="h-full animate-pulse bg-muted/20" aria-label="页面加载中" />
}

const loadCrawlLog = () => import('@/components/crawl-log-tab')
const loadSettings = () => import('@/components/settings-tab')

const CrawlLogTab = dynamic(loadCrawlLog, {
  loading: AdminPageLoading,
})
const SettingsTab = dynamic(loadSettings, {
  loading: AdminPageLoading,
})

const tabLoaders: Record<TabKey, () => Promise<unknown>> = {
  'crawl-log': loadCrawlLog,
  settings: loadSettings,
}

interface NavItem {
  key: TabKey
  label: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
}

const navItems: NavItem[] = [
  { key: 'crawl-log', label: '工作台', icon: Activity },
  { key: 'settings', label: '设置', icon: Settings },
]

function readInitialTab(): TabKey {
  if (typeof window === 'undefined') return 'crawl-log'
  const params = new URLSearchParams(window.location.search)
  const tab = params.get(URL_PARAM_TAB)
  if (tab === 'settings' && !params.has('articleId') && !params.has(URL_PARAM_DETAIL)) return 'settings'
  return 'crawl-log'
}

function AdminContent({ initialTab }: { initialTab: TabKey }) {
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab)
  const [visitedTabs, setVisitedTabs] = useState<Set<TabKey>>(() => new Set([initialTab]))
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const router = useRouter()
  const [queueCounts, setQueueCounts] = useState({ human: 0, technical: 0 })

  useEffect(() => {
    setMounted(true)
    const syncFromUrl = () => {
      const tab = readInitialTab()
      setVisitedTabs((current) => current.has(tab) ? current : new Set(current).add(tab))
      setActiveTab(tab)
    }
    window.addEventListener('popstate', syncFromUrl)
    window.addEventListener('hot2:urlchange', syncFromUrl)
    return () => {
      window.removeEventListener('popstate', syncFromUrl)
      window.removeEventListener('hot2:urlchange', syncFromUrl)
    }
  }, [])

  const refreshQueueCounts = useCallback((force = false) => {
    fetchWorkQueueSummary(force).then((data) => {
      setQueueCounts({ human: data.human.total, technical: data.technical.total })
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshQueueCounts()
    const handleFocus = () => refreshQueueCounts(true)
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [refreshQueueCounts])

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }

  const handleTabChange = (tab: TabKey) => {
    setVisitedTabs((current) => current.has(tab) ? current : new Set(current).add(tab))
    setActiveTab(tab)
    refreshQueueCounts()
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (tab === 'crawl-log') url.searchParams.delete(URL_PARAM_TAB)
    else url.searchParams.set(URL_PARAM_TAB, tab)
    if (tab !== 'crawl-log') {
      url.searchParams.delete('articleId')
      url.searchParams.delete('panel')
      url.searchParams.delete(URL_PARAM_DETAIL)
      url.searchParams.delete('detailKind')
    }
    window.history.replaceState(null, '', url.toString())
  }

  const preloadTab = (tab: TabKey) => {
    void tabLoaders[tab]().then(() => {
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        window.requestIdleCallback(() => {
          setVisitedTabs((current) => current.has(tab) ? current : new Set(current).add(tab))
        }, { timeout: 1_000 })
      }
    })
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
              <h1 className="text-[13px] font-semibold leading-5 tracking-tight truncate">管理后台</h1>
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
                    onMouseEnter={() => preloadTab(item.key)}
                    onFocus={() => preloadTab(item.key)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`relative w-full flex h-10 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${isActive ? 'bg-muted text-foreground before:absolute before:left-0 before:top-2 before:h-6 before:w-0.5 before:rounded-full before:bg-foreground' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'}`}
                  >
                    <item.icon className="h-[17px] w-[17px] shrink-0" strokeWidth={1.8} />
                    <span>{item.label}</span>
                    {item.key === 'crawl-log' && (queueCounts.human + queueCounts.technical) > 0 && <span className="ml-auto text-[10px] tabular-nums text-amber-700">{queueCounts.human + queueCounts.technical}</span>}
                  </button>
                )
              })}
            </div>
          </nav>

          <div className="px-2 py-3 border-t border-border/70">
            <button
              onClick={() => router.push('/')}
              className="mb-2 w-full flex h-9 items-center gap-2 rounded-md px-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <ExternalLink className="h-[15px] w-[15px] shrink-0" strokeWidth={1.8} />
              <span>返回前台</span>
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
            <p className="mt-2 px-2.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground/70">v{APP_VERSION}</p>
          </div>
        </aside>

        <main className="flex-1 flex flex-col overflow-hidden min-h-0 bg-background">
          <div className="flex-1 overflow-hidden min-h-0 pb-16 sm:pb-0">
            {visitedTabs.has('crawl-log') && (
              <section className={activeTab === 'crawl-log' ? 'h-full' : 'hidden'} aria-hidden={activeTab !== 'crawl-log'}>
                <CrawlLogTab active={activeTab === 'crawl-log'} />
              </section>
            )}
            {visitedTabs.has('settings') && (
              <section className={activeTab === 'settings' ? 'h-full' : 'hidden'} aria-hidden={activeTab !== 'settings'}>
                <SettingsTab active={activeTab === 'settings'} />
              </section>
            )}
          </div>
        </main>
      </div>

      <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur border-t flex items-center justify-around h-16 pb-[env(safe-area-inset-bottom)]">
        {navItems.map((item) => {
          const isActive = activeTab === item.key
          return (
            <button
              key={item.key}
              onClick={() => handleTabChange(item.key)}
              onTouchStart={() => preloadTab(item.key)}
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

export default function AdminShell({ initialTab = 'crawl-log' }: { initialTab?: TabKey }) {
  return <AdminContent initialTab={initialTab} />
}
