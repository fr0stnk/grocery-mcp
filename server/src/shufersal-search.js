import fs from 'node:fs';
import { StoreError } from './normalize.js';

const ORIGIN = 'https://www.shufersal.co.il';

function domainMatches(host, cookieDomain) {
  if (cookieDomain.startsWith('.')) {
    const bare = cookieDomain.slice(1);
    return host === bare || host.endsWith(`.${bare}`);
  }
  return host === cookieDomain;
}

/**
 * The Cookie header for a URL from the adapter's saved session, using the
 * adapter's own matching rules. The file is only read: the adapter remains the
 * only process that refreshes and saves the session.
 */
export function cookieHeader(file, url, now = Date.now()) {
  const { cookies = [] } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const u = new URL(url);
  return cookies
    .filter((c) => (c.expires === -1 || c.expires * 1000 > now) && domainMatches(u.hostname, c.domain) && u.pathname.startsWith(c.path || '/') && (!c.secure || u.protocol === 'https:'))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Searches Shufersal with the saved session and returns the raw results. Unlike
 * the adapter's search, these include the barcode, stock, promotion text and the
 * store's own comparison price.
 */
export async function fetchShufersalSearch(query, { cookieFile, limit = 20, origin = ORIGIN, timeoutMs = 20_000 } = {}) {
  if (!cookieFile) throw new StoreError('shufersal: no saved session file is configured');
  const url = `${origin}/online/he/search/results?q=${encodeURIComponent(query)}:relevance&limit=${limit}`;
  let cookie;
  try {
    cookie = cookieHeader(cookieFile, url);
  } catch (error) {
    throw new StoreError(`shufersal: cannot read the saved session: ${error.code ?? error.message}`);
  }
  if (!cookie) throw new StoreError('shufersal: the saved session has no valid cookies');

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: '*/*',
        'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${origin}/online/he/A`,
        Cookie: cookie,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new StoreError(`shufersal: search request failed: ${error.name === 'TimeoutError' ? 'timed out' : error.cause?.code ?? error.message}`);
  }
  const type = response.headers.get('content-type') ?? '';
  if (response.status !== 200 || !type.includes('json')) {
    throw new StoreError(`shufersal: search returned HTTP ${response.status} (${type || 'no content type'}); the session may have expired`);
  }
  const body = await response.json();
  if (!Array.isArray(body.results)) throw new StoreError('shufersal: search response has no results array');
  return body.results;
}
