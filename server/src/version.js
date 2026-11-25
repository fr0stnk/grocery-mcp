import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// server/package.json is the single source of the version; CI checks that release tags match it.
export const VERSION = createRequire(import.meta.url)('../package.json').version;

/** The commit of a checkout, or null outside git (for example inside the image). */
function gitCommit(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || null;
  } catch {
    return null;
  }
}

const valid = (sha) => (typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null);

/**
 * What is running. Images get these values as build arguments from CI; local
 * runs read them from git.
 */
export function buildInfo(env = process.env, root = repoRoot) {
  const commit = valid(env.GROCERY_COMMIT) ?? gitCommit(root);
  return {
    version: VERSION,
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    buildDate: env.GROCERY_BUILD_DATE || null,
    imageTag: env.GROCERY_IMAGE_TAG || null,
    upstream: {
      'rami-levy': valid(env.GROCERY_UPSTREAM_RAMI_LEVY) ?? gitCommit(path.join(root, 'upstream/rami-levy-mcp')),
      shufersal: valid(env.GROCERY_UPSTREAM_SHUFERSAL) ?? gitCommit(path.join(root, 'upstream/shufersal-cart')),
    },
  };
}

export const BUILD = buildInfo();

/** Semantic-versioning build metadata, e.g. 0.1.0+2f08eed, as reported in serverInfo. */
export const FULL_VERSION = BUILD.shortCommit ? `${VERSION}+${BUILD.shortCommit}` : VERSION;
