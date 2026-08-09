import { db } from '@/lib/db';
import { getSeedSettingDefaults } from '../src/lib/settings-catalog';
import { PRESET_SOURCES } from '../src/lib/preset-sources';
import { TOOL_DIRECTORY_SEED } from '../src/lib/tool-directory-seed';

async function seed() {
  // 预设源只负责初始化配置，默认禁用，避免首次启动自动抓取。
  for (const s of PRESET_SOURCES) {
    const existing = await db.source.findFirst({ where: { name: s.name } });
    if (!existing) {
      await db.source.create({
        data: {
          name: s.name,
          type: s.type,
          url: s.url,
          parserConfig: s.parserConfig,
          enabled: false,
        },
      });
      console.log(`✓ Created default source: ${s.name}`);
    }
  }

  // Default settings
  const defaultSettings = getSeedSettingDefaults();

  for (const s of defaultSettings) {
    await db.setting.upsert({ where: { key: s.key }, update: {}, create: s });
  }
  console.log('✓ Created default settings');

  const toolDirectoryCount = await db.toolDirectoryItem.count();
  if (toolDirectoryCount === 0) {
    for (const tool of TOOL_DIRECTORY_SEED) {
      await db.toolDirectoryItem.create({
        data: {
          id: tool.id,
          name: tool.name,
          description: tool.description,
          category: tool.category,
          href: tool.href,
          icon: tool.icon,
          status: tool.status,
          tags: JSON.stringify(tool.tags),
          sortOrder: tool.sortOrder,
        },
      });
    }
    console.log(`✓ Created ${TOOL_DIRECTORY_SEED.length} default tools`);
  }

  console.log('Seed complete!');
}

seed()
  .catch((error: unknown) => {
    console.error('Seed failed!', error)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
