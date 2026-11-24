import { createRequire } from 'node:module';

// server/package.json is the single source of the version; CI checks that release tags match it.
export const VERSION = createRequire(import.meta.url)('../package.json').version;
