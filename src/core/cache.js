// Bounded LRU-ish cache backed by Map's insertion order. Replaces the old
// unbounded `new Map()` used for photo/text search results, which grew
// forever for the lifetime of the process.
export function createBoundedCache(maxSize = 500) {
  const map = new Map();

  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      // refresh recency: re-insert so it's no longer the oldest entry
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > maxSize) {
        const oldestKey = map.keys().next().value;
        map.delete(oldestKey);
      }
    },
    get size() {
      return map.size;
    },
  };
}
