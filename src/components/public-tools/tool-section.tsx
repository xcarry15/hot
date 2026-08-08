import PublicToolCard from './tool-card';
import type { PublicToolCategory } from './types';

export default function PublicToolSection({
  category,
  sectionIndex,
}: {
  category: PublicToolCategory;
  sectionIndex: number;
}) {
  return (
    <section
      aria-labelledby={`public-tool-category-${category.id}`}
      className="public-section-enter"
    >
      <div className="mb-4 flex items-center gap-3 sm:mb-5">
        <h2 id={`public-tool-category-${category.id}`} className="public-display shrink-0 text-xl text-[var(--public-ink)] sm:text-2xl">{category.label}</h2>
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--public-hairline)]" />
        <span className="shrink-0 text-xs tabular-nums text-[var(--public-muted)]">{category.tools.length} 项</span>
      </div>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 lg:gap-5">
        {category.tools.map((tool, toolIndex) => (
          <PublicToolCard key={tool.id} tool={tool} revealIndex={sectionIndex * 2 + toolIndex} />
        ))}
      </ul>
    </section>
  );
}
