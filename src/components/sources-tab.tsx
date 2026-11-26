 'use client'

import { useState } from 'react'
import { SourceManagement } from './sources/source-management'
import { PresetSourcesManagement } from './sources/preset-sources'
import CrawlConfig from './settings/crawl-config'
import type { Settings } from './settings/types'

type SourcesView = 'configured' | 'presets' | 'crawl'
const SOURCES_VIEWS: SourcesView[] = ['configured', 'presets', 'crawl']

// 数据源管理 — 按职能拆分为 sources/ 子目录；抓取节奏配置归属采集侧
export function SourcesManagement({ settings, setSettings }: {
  settings: Settings
  setSettings: React.Dispatch<React.SetStateAction<Settings>>
}) {
  const [view, setView] = useState<SourcesView>('configured')

  const handleTabKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const current = SOURCES_VIEWS.indexOf(view)
    const delta = event.key === 'ArrowRight' ? 1 : -1
    setView(SOURCES_VIEWS[(current + delta + SOURCES_VIEWS.length) % SOURCES_VIEWS.length])
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b bg-background px-2 py-1.5">
        <span className="mr-1 text-xs font-semibold text-foreground">数据源</span>
        <div
          role="tablist"
          aria-label="数据源管理视图"
          className="inline-flex items-center border bg-background"
          onKeyDown={handleTabKeyDown}
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'configured'}
            tabIndex={view === 'configured' ? 0 : -1}
            onClick={() => setView('configured')}
            className={`border-r px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              view === 'configured'
                ? 'bg-foreground font-medium text-background'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            已配置
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'presets'}
            tabIndex={view === 'presets' ? 0 : -1}
            onClick={() => setView('presets')}
            className={`border-r px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              view === 'presets'
                ? 'bg-foreground font-medium text-background'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            预设源
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'crawl'}
            tabIndex={view === 'crawl' ? 0 : -1}
            onClick={() => setView('crawl')}
            className={`px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              view === 'crawl'
                ? 'bg-foreground font-medium text-background'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            抓取配置
          </button>
        </div>
      </div>

      <div className={view === 'crawl' ? 'min-h-0 flex-1 overflow-auto' : 'min-h-0 flex-1'}>
        {view === 'configured'
          ? <SourceManagement />
          : view === 'presets'
            ? <PresetSourcesManagement />
            : <CrawlConfig settings={settings} setSettings={setSettings} />}
      </div>
    </div>
  )
}

export { SourceManagement, PresetSourcesManagement }
export { StatusLight } from './sources/status-light'
