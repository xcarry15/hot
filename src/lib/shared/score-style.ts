export interface ScoreStyle {
  bg: string
  text: string
  textOnly: string
  feishuColor: string
}

export function getScoreStyle(score: number): ScoreStyle {
  if (score >= 100) return { bg: 'bg-amber-500', text: 'text-white', textOnly: 'text-amber-600', feishuColor: 'orange' }
  if (score >= 90) return { bg: 'bg-violet-500', text: 'text-white', textOnly: 'text-violet-600', feishuColor: 'purple' }
  if (score >= 80) return { bg: 'bg-emerald-100', text: 'text-emerald-700', textOnly: 'text-emerald-600', feishuColor: 'green' }
  if (score >= 70) return { bg: 'bg-blue-100', text: 'text-blue-700', textOnly: 'text-blue-600', feishuColor: 'blue' }
  if (score >= 60) return { bg: 'bg-amber-100', text: 'text-amber-700', textOnly: 'text-amber-600', feishuColor: 'yellow' }
  return { bg: 'bg-slate-100', text: 'text-slate-400', textOnly: 'text-slate-400', feishuColor: 'grey' }
}

