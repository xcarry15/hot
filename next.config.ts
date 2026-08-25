import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 远程开发浏览器通过服务器公网 IP 访问时，允许 Next.js 的 HMR 和字体资源。
  allowedDevOrigins: ['43.166.0.19'],
  turbopack: {
    // 生产版本在 releases/<id> 中构建；避免被应用根目录遗留的 lockfile
    // 误判为 workspace root，导致 .next 写到 release 目录之外。
    root: process.cwd(),
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
};

export default nextConfig;
