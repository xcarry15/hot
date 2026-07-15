import Link from "next/link";
import PublicFooter from "@/components/public-footer";
import PublicHeader from "@/components/public-header";

export const dynamic = "force-dynamic";

export default function PublicToolsPage() {
  return (
    <div className="public-site flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublicHeader active="tools" />

      <main className="mx-auto flex w-full max-w-[1200px] flex-1 items-center px-4 py-16 sm:px-6 sm:py-24">
        <section className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-[var(--public-primary)]">
            即将上线
          </p>
          <h1 className="public-display mt-4 text-4xl leading-tight text-[var(--public-ink)] sm:text-5xl">
            敬请期待...
          </h1>
          <p className="mt-6 max-w-xl text-base leading-8 text-[var(--public-body)]">
            更多免费、实用、专业的选址规划工具正在准备中!
          </p>
          <Link
            href="/"
            className="mt-8 inline-flex h-10 items-center border border-[var(--public-ink)] px-4 text-sm font-medium text-[var(--public-ink)] transition-colors hover:border-[var(--public-primary)] hover:text-[var(--public-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-primary)]"
          >
            返回文章列表
          </Link>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
