/**
 * Cache TTL simple en mémoire pour limiter les appels Yahoo lors du build watchlist.
 */

export function createWatchlistCache() {
  /** @type {Map<string, { value: unknown, expiresAt: number }>} */
  const store = new Map();

  /**
   * @param {string} key
   * @returns {unknown | undefined}
   */
  function get(key) {
    const row = store.get(key);
    if (!row) return undefined;
    if (Date.now() > row.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return row.value;
  }

  /**
   * @param {string} key
   * @param {unknown} value
   * @param {number} ttlMs
   */
  function set(key, value, ttlMs) {
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  function clear() {
    store.clear();
  }

  return { get, set, clear };
}
