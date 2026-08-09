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
      <div className="mb-2.5 flex items-baseline gap-2.5 sm:mb-3">
        <h2 id={`public-tool-category-${category.id}`} className="public-display text-lg text-[var(--public-ink)] sm:text-xl">{category.label}</h2>
        <span className="text-xs tabular-nums text-[var(--public-muted)]">{category.tools.length} 项</span>
      </div>

      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-3 lg:grid-cols-4">
        {category.tools.map((tool, toolIndex) => (
          <PublicToolCard key={tool.id} tool={tool} revealIndex={sectionIndex * 2 + toolIndex} />
        ))}
      </ul>
    </section>
  );
}
