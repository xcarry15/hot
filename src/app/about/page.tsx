import type { Metadata } from "next";
import Image from "next/image";
import PublicPageShell from "@/components/public-page-shell";
import { PUBLIC_BROWSER_SITE_NAME, PUBLIC_SITE_NAME } from "@/lib/public-brand";
import FeishuGroupQrCode from "@/pic/QRcode/飞书群-资讯推送.jpg";
import WechatQrCode from "@/pic/QRcode/微信-沈浪.jpg";

export const metadata: Metadata = {
  title: `关于 · ${PUBLIC_BROWSER_SITE_NAME}`,
  description: `了解${PUBLIC_SITE_NAME}提供的精选资讯、选址与数据工具。`,
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <PublicPageShell
      active="about"
      mainClassName="px-4 pb-2 pt-7 sm:px-6 sm:pb-3 sm:pt-10"
    >
      <article className="mx-auto max-w-4xl">
        {/* 头部英雄区域 */}
        <header className="public-section-enter relative mb-16 overflow-hidden bg-gradient-to-br from-[var(--public-surface-soft)] to-[var(--public-surface-strong)] p-8 sm:mb-20 sm:p-12">
          {/* 装饰性背景元素 */}
          <div className="absolute right-0 top-0 h-32 w-32 translate-x-1/2 -translate-y-1/2 bg-[var(--public-primary)] opacity-10 blur-3xl" />
          <div className="absolute bottom-0 left-0 h-24 w-24 -translate-x-1/2 translate-y-1/2 bg-[var(--public-primary)] opacity-10 blur-2xl" />

          <div className="relative space-y-8">
            <div className="space-y-3">
              <p className="text-sm font-semibold tracking-[0.2em] text-[var(--public-primary)] uppercase">
                关于我
              </p>
              <h2 className="public-display text-2xl text-[var(--public-ink)] sm:text-3xl">
                我是 <span className="text-[var(--public-primary)] text-[clamp(1.8rem,5vw,3rem)] font-bold">沈浪</span> 专注商业分析/数字化选址
              </h2>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-semibold tracking-[0.2em] text-[var(--public-primary)] uppercase">
                本站理念
              </p>
              <h2 className="public-display text-2xl text-[var(--public-ink)] sm:text-3xl">
                让你的时间花在 <span className="text-[var(--public-primary)] text-[clamp(1.8rem,5vw,3rem)] font-bold">更有价值的决策上</span> 
              </h2>
            </div>
          </div>
        </header>

        {/* 联系方式区域 */}
        <section
          className="public-section-enter public-detail-delay-2"
          aria-labelledby="about-contact-title"
        >
          <header className="mb-4 text-center">

            <h2
              id="about-contact-title"
              className="public-display mt-1 text-2xl text-[var(--public-ink)] sm:text-3xl"
            >
              选择适合你的方式
            </h2>
          </header>

          <div className="grid gap-6 sm:grid-cols-2">
            <figure className="group relative overflow-hidden border border-[var(--public-hairline)] bg-[var(--public-surface-soft)] p-6 transition-all duration-300 hover:border-[var(--public-primary)] hover:shadow-lg sm:grid sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center sm:gap-6 sm:p-8">
              <div className="relative mx-auto h-32 w-32 shrink-0 overflow-hidden bg-white p-2 shadow-sm sm:mx-0">
                <Image
                  src={FeishuGroupQrCode}
                  alt="飞书群资讯推送二维码"
                  className="h-full w-full object-contain"
                  sizes="(min-width: 640px) 192px, 128px"
                  priority
                />
              </div>
              <figcaption className="mt-4 text-center sm:mt-0 sm:text-left">
                <div className="inline-flex items-center gap-2 bg-gradient-to-r from-[var(--public-primary)] via-[rgb(230,140,100)] to-[var(--public-primary)] bg-[length:200%_auto] px-3 py-1 text-xs font-medium text-white shadow-[0_0_25px_rgba(204,120,92,0.9),0_0_50px_rgba(204,120,92,0.5)] animate-[pulse_1s_ease-in-out_infinite] hover:scale-110 transition-transform duration-300">
                  每日推送
                </div>
                <h3 className="mt-3 text-xl font-semibold text-[var(--public-ink)]">
                  加入飞书群
                </h3>
                <p className="mt-2 text-sm leading-6 text-[var(--public-muted)]">
                  自动接收精选行业资讯，不错过重要动态
                </p>
              </figcaption>
            </figure>

            <figure className="group relative overflow-hidden border border-[var(--public-hairline)] bg-[var(--public-surface-soft)] p-6 transition-all duration-300 hover:border-[var(--public-primary)] hover:shadow-lg sm:grid sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center sm:gap-6 sm:p-8">
              <div className="relative mx-auto h-32 w-32 shrink-0 overflow-hidden bg-white p-2 shadow-sm sm:mx-0">
                <Image
                  src={WechatQrCode}
                  alt="微信二维码"
                  className="h-full w-full object-contain"
                  sizes="(min-width: 640px) 192px, 128px"
                />
              </div>
              <figcaption className="mt-4 text-center sm:mt-0 sm:text-left">
                <div className="inline-flex items-center gap-2 bg-[var(--public-surface-strong)] px-3 py-1 text-xs font-medium text-[var(--public-primary)]">
                  随时交流
                </div>
                <h3 className="mt-3 text-xl font-semibold text-[var(--public-ink)]">
                  添加微信
                </h3>
                <p className="mt-2 text-sm leading-6 text-[var(--public-muted)]">
                  任何想法、建议，都可以随意沟通
                </p>
              </figcaption>
            </figure>
          </div>
        </section>

        {/* 底部版权 */}
        <footer className="public-section-enter public-detail-delay-3 mt-8 pt-4 text-center sm:mt-10 sm:pt-6">
          <p className="text-xs leading-6 text-[var(--public-muted)]">
            本站仅提供聚合摘要与阅读索引；原文版权及准确信息以原始来源为准。
          </p>
        </footer>
      </article>
    </PublicPageShell>
  );
}
