import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { PUBLIC_SITE_DESCRIPTION, PUBLIC_SITE_NAME } from "@/lib/public-brand";
import { getPublicSiteUrl } from "@/lib/public-site";
import appleTouchIcon from "@/pic/Logo/apple-touch-icon.png";
import logo from "@/pic/Logo/icon-192x192.png";

// 数据看板每次刷新内容都不同，强制动态渲染：
// 禁止 build 时预渲染并将 HTML 标记 s-maxage=31536000，
// 否则重新部署后浏览器/共享缓存的旧 HTML 仍引用已被删除的旧 chunk → 404。
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  metadataBase: getPublicSiteUrl(),
  title: PUBLIC_SITE_NAME,
  description: PUBLIC_SITE_DESCRIPTION,
  applicationName: PUBLIC_SITE_NAME,
  icons: {
    icon: [{ url: logo.src, sizes: "192x192", type: "image/png" }],
    apple: appleTouchIcon.src,
  },
  manifest: "/manifest.webmanifest",
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
