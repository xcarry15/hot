/** Export 的分页/游标边界，避免工作簿编排文件混入查询迭代细节。 */
export const EXPORT_BATCH_SIZE = 250;

export function splitIds(ids: Set<string>): string[][] {
  const values = [...ids];
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += 500) chunks.push(values.slice(index, index + 500));
  return chunks;
}

export async function appendByIdChunksPaged<T extends { id: string }>(
  ids: Set<string>,
  load: (chunk: string[], cursor?: string) => Promise<T[]>,
  append: (rows: T[]) => void | Promise<void>,
): Promise<void> {
  for (const chunk of splitIds(ids)) {
    let cursor: string | undefined;
    while (true) {
      const page = await load(chunk, cursor);
      if (page.length === 0) break;
      await append(page);
      if (page.length < EXPORT_BATCH_SIZE) break;
      cursor = page[page.length - 1].id;
    }
  }
}

export async function appendIdPages<T extends { id: string }>(
  load: (cursor?: string) => Promise<T[]>,
  append: (rows: T[]) => void | Promise<void>,
): Promise<void> {
  let cursor: string | undefined;
  while (true) {
    const page = await load(cursor);
    if (page.length === 0) break;
    await append(page);
    if (page.length < EXPORT_BATCH_SIZE) break;
    cursor = page[page.length - 1].id;
  }
}
