 'use client'

import { useState } from 'react'
import { SourceManagement } from './sources/source-management'
import { PresetSourcesManagement } from './sources/preset-sources'

// 数据源管理 — 按职能拆分为 sources/ 子目录
export function SourcesManagement() {
  const [view, setView] = useState<'configured' | 'presets'>('configured')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-2 py-1.5">
        <span className="mr-1 text-xs font-semibold text-foreground">数据源</span>
        <div
          role="tablist"
          aria-label="数据源管理视图"
          className="inline-flex items-center rounded-md bg-muted p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'configured'}
            onClick={() => setView('configured')}
            className={`rounded px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              view === 'configured'
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            已配置
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'presets'}
            onClick={() => setView('presets')}
            className={`rounded px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              view === 'presets'
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            预设源
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {view === 'configured' ? <SourceManagement /> : <PresetSourcesManagement />}
      </div>
    </div>
  )
}

export { SourceManagement, PresetSourcesManagement }
export { StatusLight } from './sources/status-light'
