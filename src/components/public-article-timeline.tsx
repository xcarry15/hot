import type { PublicArticleDateGroupDto } from '@/contracts/public-articles'
import { getPublicDateLabel, getPublicDayLabel } from '@/lib/shared/public-date'
import PublicArticleCard from '@/components/public-article-card'
import type { CSSProperties } from 'react'

interface Props {
  groups: PublicArticleDateGroupDto[]
}

export default function PublicArticleTimeline({ groups }: Props) {
  return (
    <div>
      {groups.map((group, groupIndex) => (
        <section key={group.date} aria-labelledby={`public-date-group-${group.date}`}>
          <h2
            id={`public-date-group-${group.date}`}
            className={`public-date-heading public-display px-1 text-xl sm:text-2xl ${groupIndex === 0 ? 'text-[var(--public-primary)]' : 'text-[var(--public-ink)]'}`}
            style={{ '--public-reveal-delay': `${Math.min(groupIndex, 3) * 30}ms` } as CSSProperties}
          >
            {getPublicDayLabel(group.date)}
          </h2>
          <ol className="mt-1" aria-label={`${getPublicDateLabel(group.date)}文章`}>
            {group.items.map((article, articleIndex) => (
              <PublicArticleCard
                key={article.id}
                article={article}
                revealIndex={groupIndex * 2 + articleIndex}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}
