/** Loads the real built-in binding through Node, preserving its required node: prefix. */
import { createRequire } from 'node:module';

export const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
