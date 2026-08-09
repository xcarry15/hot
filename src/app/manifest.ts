import type { MetadataRoute } from 'next';
import icon192 from '@/pic/Logo/icon-192x192.png';
import icon512 from '@/pic/Logo/icon-512x512.png';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '开发选址助手',
    short_name: '开发选址助手',
    description: '精选行业资讯，汇集选址、地图与数据分析工具。',
    lang: 'zh-CN',
    icons: [
      {
        src: icon192.src,
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: icon512.src,
        sizes: '512x512',
        type: 'image/png',
      },
    ],
    theme_color: '#faf9f5',
    background_color: '#faf9f5',
    display: 'standalone',
  };
}
