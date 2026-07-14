import { db } from '@/lib/db';
import { getSeedSettingDefaults } from '../src/lib/settings-catalog';
import { PRESET_SOURCES } from '../src/lib/preset-sources';

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

  console.log('Seed complete!');
}

seed().catch(console.error).finally(() => process.exit());
