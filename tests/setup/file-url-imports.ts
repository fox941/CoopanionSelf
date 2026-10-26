/** Resolves file-URL paths left encoded by Vite's dynamic import handling. */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function fileUrlImports() {
  return {
    name: 'file-url-imports',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id.startsWith('file:')) return fileURLToPath(id);
      if (!isAbsolute(id) || !/%[0-9a-f]{2}/i.test(id) || existsSync(id)) return;
      let decoded: string;
      try {
        decoded = decodeURIComponent(id);
      } catch {
        return;
      }
      if (existsSync(decoded)) return decoded;
    },
  };
}
