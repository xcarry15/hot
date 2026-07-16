import { db } from '../src/lib/db';
import { rebuildPublicPublicationSnapshot } from '../src/lib/public-publication-service';

async function main() {
  const count = await rebuildPublicPublicationSnapshot();
  console.log(`已重建公开发布快照：${count} 篇文章`);
}

main()
  .catch((error) => {
    console.error('公开发布快照重建失败', error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
