import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BUILD, buildInfo, FULL_VERSION, VERSION } from '../src/version.js';

const SHA = 'a'.repeat(40);

test('build info comes from the image environment first', () => {
  const info = buildInfo({ GROCERY_COMMIT: SHA, GROCERY_BUILD_DATE: '2026-11-25T10:00:00Z', GROCERY_IMAGE_TAG: '0.2.0', GROCERY_UPSTREAM_RAMI_LEVY: 'b'.repeat(40), GROCERY_UPSTREAM_SHUFERSAL: 'c'.repeat(40) }, '/nonexistent');
  assert.deepEqual(info, {
    version: VERSION, commit: SHA, shortCommit: 'aaaaaaa', buildDate: '2026-11-25T10:00:00Z', imageTag: '0.2.0',
    upstream: { 'rami-levy': 'b'.repeat(40), shufersal: 'c'.repeat(40) },
  });
});

test('build info falls back to git, and to null outside a checkout', () => {
  const outside = buildInfo({ GROCERY_COMMIT: 'not-a-sha' }, fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-')));
  assert.deepEqual([outside.commit, outside.shortCommit, outside.buildDate, outside.upstream['rami-levy']], [null, null, null, null]);
  // This test runs inside the repository, so git provides the commit.
  assert.match(BUILD.commit ?? '', /^[0-9a-f]{40}$/);
  assert.equal(FULL_VERSION, `${VERSION}+${BUILD.commit.slice(0, 7)}`);
});
