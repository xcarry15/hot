import {
  PROMPT_VERSION_KEYS,
  type PromptVersionKey,
  type PromptVersionSnapshot,
} from '@/lib/prompts';

export interface PromptDiffLine {
  kind: 'current' | 'version';
  value: string;
}

export interface PromptFieldDiff {
  key: PromptVersionKey;
  current: string;
  version: string;
  lines: PromptDiffLine[];
}

const MAX_DIFF_MATRIX_CELLS = 80_000;

function normalizeLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

/**
 * 只展示发生变化的非空行。使用 LCS 保留上下文，不引入编辑器或大型 diff 依赖。
 */
export function diffPromptLines(current: string, version: string): PromptDiffLine[] {
  const currentLines = normalizeLines(current);
  const versionLines = normalizeLines(version);

  if (currentLines.join('\n') === versionLines.join('\n')) return [];

  if (currentLines.length * versionLines.length > MAX_DIFF_MATRIX_CELLS) {
    return [
      ...currentLines.map((value) => ({ kind: 'current' as const, value })),
      ...versionLines.map((value) => ({ kind: 'version' as const, value })),
    ];
  }

  const matrix = Array.from(
    { length: currentLines.length + 1 },
    () => new Uint16Array(versionLines.length + 1),
  );

  for (let currentIndex = 1; currentIndex <= currentLines.length; currentIndex += 1) {
    for (let versionIndex = 1; versionIndex <= versionLines.length; versionIndex += 1) {
      matrix[currentIndex][versionIndex] = currentLines[currentIndex - 1] === versionLines[versionIndex - 1]
        ? matrix[currentIndex - 1][versionIndex - 1] + 1
        : Math.max(matrix[currentIndex - 1][versionIndex], matrix[currentIndex][versionIndex - 1]);
    }
  }

  const reversed: PromptDiffLine[] = [];
  let currentIndex = currentLines.length;
  let versionIndex = versionLines.length;
  while (currentIndex > 0 && versionIndex > 0) {
    if (currentLines[currentIndex - 1] === versionLines[versionIndex - 1]) {
      currentIndex -= 1;
      versionIndex -= 1;
    } else if (matrix[currentIndex - 1][versionIndex] > matrix[currentIndex][versionIndex - 1]) {
      reversed.push({ kind: 'current', value: currentLines[currentIndex - 1] });
      currentIndex -= 1;
    } else {
      reversed.push({ kind: 'version', value: versionLines[versionIndex - 1] });
      versionIndex -= 1;
    }
  }
  while (currentIndex > 0) {
    reversed.push({ kind: 'current', value: currentLines[currentIndex - 1] });
    currentIndex -= 1;
  }
  while (versionIndex > 0) {
    reversed.push({ kind: 'version', value: versionLines[versionIndex - 1] });
    versionIndex -= 1;
  }

  return reversed.reverse();
}

export function comparePromptSnapshots(
  current: PromptVersionSnapshot,
  version: PromptVersionSnapshot,
): PromptFieldDiff[] {
  return PROMPT_VERSION_KEYS.flatMap((key) => (
    current[key] === version[key]
      ? []
      : [{ key, current: current[key], version: version[key], lines: diffPromptLines(current[key], version[key]) }]
  ));
}
