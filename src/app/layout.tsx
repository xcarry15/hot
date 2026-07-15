import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { getPublicSiteUrl } from "@/lib/public-site";

// 数据看板每次刷新内容都不同，强制动态渲染：
// 禁止 build 时预渲染并将 HTML 标记 s-maxage=31536000，
// 否则重新部署后浏览器/共享缓存的旧 HTML 仍引用已被删除的旧 chunk → 404。
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  metadataBase: getPublicSiteUrl(),
  title: "行业新闻聚合推送器",
  description: "自动抓取 · AI分析 · 飞书推送",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-96x96.png", sizes: "96x96", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className="font-sans antialiased bg-background text-foreground"
      >
        <ThemeProvider>
          {children}
          <Toaster
            position="bottom-right"
            richColors
            closeButton
            // 桌面用默认 offset；移动端避开底部 tab bar (h-16=64px) + 安全区
            mobileOffset={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.5rem)' }}
            toastOptions={{
              className: 'sm:max-w-sm',
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
