/** Character-owned prompt documents start empty and are never replaced by app templates. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SELF_SYSTEM_FILE = 'SYSTEM.md';
export const SELF_CONSTITUTION_FILE = 'CONSTITUTION.md';
export const SELF_PROMPT_FILES = [SELF_CONSTITUTION_FILE, SELF_SYSTEM_FILE] as const;

export function ensureSelfPrompts(workspace: string): void {
  for (const name of SELF_PROMPT_FILES) {
    const file = join(workspace, name);
    if (!existsSync(file)) writeFileSync(file, '', 'utf8');
  }
}

export function readSelfPrompt(workspace: string, name: string): string {
  try { return readFileSync(join(workspace, name), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
