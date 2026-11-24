import { StoreError } from './normalize.js';

const DEFAULT_URL = 'https://www.rami-levy.co.il/api/catalog';
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

/**
 * Searches Rami Levy's public catalog directly. It needs no login, and unlike
 * the adapter's search it returns barcodes and promotions. The adapter is
 * still used for carts and orders.
 */
export async function fetchRamiCatalog(query, { url = DEFAULT_URL, store = '412', userAgent, cookie, timeoutMs = 20_000 } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': userAgent || DEFAULT_UA,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ q: query, store: String(store) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new StoreError(`rami-levy: catalog request failed: ${networkReason(error)}`);
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StoreError(`rami-levy: catalog returned a non-JSON page (HTTP ${response.status}), possibly a Cloudflare challenge`);
  }
  if (!response.ok) throw new StoreError(`rami-levy: catalog returned HTTP ${response.status}`);
  return data;
}

/** fetch hides the network cause, sometimes inside an AggregateError (one per address tried). */
function networkReason(error) {
  if (error.name === 'TimeoutError') return 'timed out';
  const cause = error.cause;
  return cause?.code ?? cause?.errors?.find((e) => e.code)?.code ?? cause?.message ?? error.message;
}
