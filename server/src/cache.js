/**
 * In-memory cache for store searches. Results younger than `ttlMs` are reused,
 * empty ones only for `emptyTtlMs`: a store under load answers some searches
 * with nothing, and that must not hide its products for long. An empty answer
 * where results were found before keeps the earlier results, marked stale.
 * When a fresh fetch fails, results up to `staleMs` old are returned and
 * marked stale instead of failing. Concurrent loads of one key share a fetch.
 */
export class SearchCache {
  constructor({ ttlMs = 15 * 60_000, emptyTtlMs = 60_000, staleMs = 24 * 60 * 60_000, maxEntries = 2000, now = () => Date.now() } = {}) {
    Object.assign(this, { ttlMs, emptyTtlMs, staleMs, maxEntries, now });
    this.entries = new Map();
    this.pending = new Map();
  }

  /** Resolves to { value, fetchedAt, cached, stale?, error? }. */
  async get(key, load) {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.at < this.#ttlOf(entry.value)) {
      return { value: entry.value, fetchedAt: new Date(entry.at).toISOString(), cached: true };
    }
    if (!this.pending.has(key)) {
      this.pending.set(
        key,
        Promise.resolve()
          .then(load)
          .then((value) => {
            const before = this.entries.get(key);
            if (isEmpty(value) && before && !isEmpty(before.value) && this.now() - before.at < this.staleMs) {
              return { kept: before, error: 'the store returned no results this time' };
            }
            this.#set(key, value);
            return value;
          })
          .finally(() => this.pending.delete(key)),
      );
    }
    try {
      const value = await this.pending.get(key);
      if (value?.kept) return { value: value.kept.value, fetchedAt: new Date(value.kept.at).toISOString(), cached: true, stale: true, error: value.error };
      return { value, fetchedAt: new Date(this.entries.get(key)?.at ?? this.now()).toISOString(), cached: false };
    } catch (error) {
      if (entry && this.now() - entry.at < this.staleMs) {
        return { value: entry.value, fetchedAt: new Date(entry.at).toISOString(), cached: true, stale: true, error: error.message };
      }
      throw error;
    }
  }

  clear() {
    this.entries.clear();
  }

  /** The first item, in any fresh cached result list, that satisfies `match`. */
  findFresh(match) {
    for (const entry of this.entries.values()) {
      if (this.now() - entry.at >= this.#ttlOf(entry.value) || !Array.isArray(entry.value)) continue;
      const found = entry.value.find(match);
      if (found) return { item: found, fetchedAt: new Date(entry.at).toISOString() };
    }
    return null;
  }

  #ttlOf(value) {
    return isEmpty(value) ? Math.min(this.emptyTtlMs, this.ttlMs) : this.ttlMs;
  }

  #set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
}

const isEmpty = (value) => Array.isArray(value) && value.length === 0;

/** Runs at most `limit` tasks at once; tasks are functions returning promises. */
export function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}
