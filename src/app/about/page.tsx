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
        <header className="public-section-enter max-w-3xl">
          <p className="text-xs font-semibold tracking-[0.16em] text-[var(--public-primary)]">
            关于本站
          </p>
          <h1 className="public-display mt-3 whitespace-nowrap text-[clamp(1.35rem,5.5vw,3rem)] leading-[1.18] text-[var(--public-ink)]">
            少一点信息噪音，<span className="text-[var(--public-primary)]">多一点有效判断。</span>
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-8 text-[var(--public-body)]">
            我是<span className="font-semibold text-[var(--public-ink)]">沈浪</span>。这里每天筛选行业资讯，并提供选址与数据工具，帮助你更快看懂市场、找到位置。
          </p>
        </header>

        <section
          className="public-section-enter public-detail-delay-1 mt-7 grid gap-3 sm:mt-8 sm:grid-cols-2 sm:gap-4"
          aria-label="本站提供的内容"
        >
          <div className="bg-[var(--public-surface-soft)] px-5 py-4">
            <p className="text-xs font-semibold text-[var(--public-primary)]">
              01 · 精选资讯
            </p>
            <p className="mt-2 text-sm leading-7 text-[var(--public-body)]">
              聚合、筛选并去重，只保留值得关注的行业动态。
            </p>
          </div>
          <div className="bg-[var(--public-surface-soft)] px-5 py-4">
            <p className="text-xs font-semibold text-[var(--public-primary)]">
              02 · 实用工具
            </p>
            <p className="mt-2 text-sm leading-7 text-[var(--public-body)]">
              汇集选址、地图与数据分析工具，方便快速使用。
            </p>
          </div>
        </section>

        <section
          className="public-section-enter public-detail-delay-2 mt-9 sm:mt-11"
          aria-labelledby="about-contact-title"
        >
          <header className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-[var(--public-primary)]">
                保持联系
              </p>
              <h2
                id="about-contact-title"
                className="public-display mt-1 text-2xl text-[var(--public-ink)] sm:text-3xl"
              >
                选择适合你的方式
              </h2>
            </div>
            <p className="hidden shrink-0 text-xs text-[var(--public-muted)] sm:block">
              扫码即可加入
            </p>
          </header>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 sm:gap-4">
            <figure className="bg-[var(--public-surface-soft)] p-4 sm:grid sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center sm:gap-4 sm:p-5">
              <Image
                src={FeishuGroupQrCode}
                alt="飞书群资讯推送二维码"
                className="mx-auto h-auto w-full max-w-44 bg-white object-contain sm:mx-0 sm:w-40"
                sizes="(min-width: 640px) 160px, 176px"
                priority
              />
              <figcaption className="mt-3 text-center sm:mt-0 sm:text-left">
                <p className="text-xs font-medium text-[var(--public-primary)]">
                  每日精选
                </p>
                <h3 className="mt-1 text-base font-semibold text-[var(--public-ink)]">
                  加入飞书群
                </h3>
                <p className="mt-2 text-xs leading-6 text-[var(--public-muted)]">
                  接收筛选后的行业资讯。
                </p>
              </figcaption>
            </figure>

            <figure className="bg-[var(--public-surface-soft)] p-4 sm:grid sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center sm:gap-4 sm:p-5">
              <Image
                src={WechatQrCode}
                alt="个人微信沈浪二维码"
                className="mx-auto h-auto w-full max-w-44 bg-white object-contain sm:mx-0 sm:w-40"
                sizes="(min-width: 640px) 160px, 176px"
              />
              <figcaption className="mt-3 text-center sm:mt-0 sm:text-left">
                <p className="text-xs font-medium text-[var(--public-primary)]">
                  交流建议
                </p>
                <h3 className="mt-1 text-base font-semibold text-[var(--public-ink)]">
                  添加沈浪微信
                </h3>
                <p className="mt-2 text-xs leading-6 text-[var(--public-muted)]">
                  交流资讯、工具建议与反馈。
                </p>
              </figcaption>
            </figure>
          </div>
        </section>

        <p className="public-section-enter public-detail-delay-3 mt-7 text-xs leading-6 text-[var(--public-muted)] sm:mt-9">
          本站仅提供聚合摘要与阅读索引；原文版权及准确信息以原始来源为准。
        </p>
      </article>
    </PublicPageShell>
  );
}
