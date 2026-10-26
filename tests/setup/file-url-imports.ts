/** Resolves file-URL paths left encoded by Vite's dynamic import handling. */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function fileUrlImports() {
  return {
    name: 'file-url-imports',
    enforce: 'pre' as const,
    resolveId(id: string) {
      // Vite-node 2 strips node: from sqlite, which Node only exposes with that prefix.
      if (id === 'sqlite' || id === 'node:sqlite') return fileURLToPath(new URL('./sqlite.ts', import.meta.url));
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
