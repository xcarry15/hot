import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Bot, Fingerprint, Send, ShieldAlert } from "lucide-react";
import type { DashboardAnalytics } from "@/features/dashboard-api.client";

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export interface SourceAttention {
  sourceId: string
  sourceName: string
  sourceStatus: string
  sourceEnabled: boolean
  alerts: Array<{
    level: 'critical' | 'warning'
    icon: LucideIcon
    label: string
    value: string
    detail: string
    threshold: string
  }>
  summary: {
    criticalCount: number
    warningCount: number
  }
}

export function buildSourceAttention(analytics: DashboardAnalytics): SourceAttention[] {
  const avgScores = analytics.sources.filter(s => s.analyzed >= 3).map(s => s.avgScore)
  const avgDuplicateRate = analytics.sources.filter(s => s.analyzed >= 3).map(s => s.duplicateRate)
  const avgAdRate = analytics.sources.filter(s => s.analyzed >= 3).map(s => s.adRate)
  const avgPushRate = analytics.sources.filter(s => s.pushed > 0).map(s => s.pushRate)

  const avgScoreAvg = avgScores.length > 0 ? avgScores.reduce((a, b) => a + b, 0) / avgScores.length : 0
  const avgDuplicateRateAvg = avgDuplicateRate.length > 0 ? avgDuplicateRate.reduce((a, b) => a + b, 0) / avgDuplicateRate.length : 0
  const avgAdRateAvg = avgAdRate.length > 0 ? avgAdRate.reduce((a, b) => a + b, 0) / avgAdRate.length : 0
  const avgPushRateAvg = avgPushRate.length > 0 ? avgPushRate.reduce((a, b) => a + b, 0) / avgPushRate.length : 0

  return analytics.sources.flatMap((source) => {
    const alerts: SourceAttention['alerts'] = []

    if (source.fetchFailures > 0) {
      alerts.push({
        level: 'critical',
        icon: AlertTriangle,
        label: '抓取失败',
        value: `${source.fetchFailures} 次`,
        detail: `最近一次抓取失败，影响新内容发现`,
        threshold: `> 0 次`,
      })
    }

    if (source.analyzed >= 3) {
      if (source.avgScore < 60) {
        alerts.push({
          level: 'critical',
          icon: Bot,
          label: '内容评分低',
          value: `${source.avgScore} 分`,
          detail: `低于均值 ${avgScoreAvg.toFixed(1)} 分，可读性差或价值不足`,
          threshold: `≥ 60 分合格`,
        })
      } else if (source.avgScore < avgScoreAvg * 0.8) {
        alerts.push({
          level: 'warning',
          icon: Bot,
          label: '内容评分偏低',
          value: `${source.avgScore} 分`,
          detail: `低于同类均值 ${avgScoreAvg.toFixed(1)} 分`,
          threshold: `同类均值 ${avgScoreAvg.toFixed(1)} 分`,
        })
      }

      if (source.duplicateRate >= 0.3) {
        alerts.push({
          level: 'critical',
          icon: Fingerprint,
          label: '重复率过高',
          value: formatPercent(source.duplicateRate),
          detail: `高于同类均值 ${formatPercent(avgDuplicateRateAvg)}，大量内容与历史重复`,
          threshold: `≥ 30% 为严重`,
        })
      } else if (source.duplicateRate >= 0.15) {
        alerts.push({
          level: 'warning',
          icon: Fingerprint,
          label: '重复率偏高',
          value: formatPercent(source.duplicateRate),
          detail: `高于同类均值 ${formatPercent(avgDuplicateRateAvg)}，注意监测趋势`,
          threshold: `同类均值 ${formatPercent(avgDuplicateRateAvg)}`,
        })
      }

      if (source.adRate >= 0.3) {
        alerts.push({
          level: 'critical',
          icon: ShieldAlert,
          label: '软文率过高',
          value: formatPercent(source.adRate),
          detail: `高于同类均值 ${formatPercent(avgAdRateAvg)}，大量内容为广告/软文`,
          threshold: `≥ 30% 为严重`,
        })
      } else if (source.adRate >= 0.15) {
        alerts.push({
          level: 'warning',
          icon: ShieldAlert,
          label: '软文率偏高',
          value: formatPercent(source.adRate),
          detail: `高于同类均值 ${formatPercent(avgAdRateAvg)}，注意监测趋势`,
          threshold: `同类均值 ${formatPercent(avgAdRateAvg)}`,
        })
      }
    }

    if (source.newArticles > 0 && source.pushed === 0) {
      alerts.push({
        level: 'warning',
        icon: Send,
        label: '有新增未推送',
        value: `${source.newArticles} 篇`,
        detail: `AI完成文章但全部未推送，可能关键词配置过严或推送渠道异常`,
        threshold: `推送率 > 0%`,
      })
    }

    if (source.pushed > 0 && avgPushRateAvg > 0 && source.pushRate < avgPushRateAvg * 0.5) {
      alerts.push({
        level: 'warning',
        icon: Send,
        label: '推送率偏低',
        value: formatPercent(source.pushRate),
        detail: `低于同类均值 ${formatPercent(avgPushRateAvg)}，内容质量或关键词匹配效率低`,
        threshold: `同类均值 ${formatPercent(avgPushRateAvg)}`,
      })
    }

    if (alerts.length === 0) return []

    const criticalCount = alerts.filter(a => a.level === 'critical').length
    const warningCount = alerts.filter(a => a.level === 'warning').length

    return [{
      sourceId: source.id,
      sourceName: source.name,
      sourceStatus: source.status,
      sourceEnabled: source.enabled,
      alerts,
      summary: { criticalCount, warningCount },
    }]
  })
}

export function statusConfig(status: string, enabled: boolean) {
  if (!enabled) return { label: '已禁用', variant: 'secondary' as const }
  if (status === 'breaker') return { label: '熔断', variant: 'destructive' as const }
  if (status === 'warning') return { label: '警告', variant: 'outline' as const }
  if (status === 'normal') return { label: '正常', variant: 'secondary' as const }
  return { label: '未抓取', variant: 'secondary' as const }
}

