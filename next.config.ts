import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
