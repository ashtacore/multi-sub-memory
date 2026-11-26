import { readFileSync } from 'node:fs';

export const MEMORY_GUIDE_URI = 'skill://multi-sub-memory/memory-guide';

export function readMemoryGuide() {
  return readFileSync(new URL('../skills/multi-sub-memory/SKILL.md', import.meta.url), 'utf8');
}
