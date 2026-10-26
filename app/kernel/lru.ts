/** Values by key, retaining only the most recently used. */
export type Lru<K, V> = {
    /** The value for `key`, which then counts as the most recently used. */
    readonly get: (key: K) => V | undefined;
    /** Stores `value` for `key`, dropping the least recently used value once there are too many. */
    readonly set: (key: K, value: V) => void;
    /** Removes the value for `key`. */
    readonly delete: (key: K) => void;
};

/** An LRU cache of at most `capacity` values. */
export const lru = <K, V>(capacity: number): Lru<K, V> => {
    // A Map iterates in insertion order, so the least recently used key comes first.
    const entries = new Map<K, V>();

    return {
        get: (key) => {
            const value = entries.get(key);
            if (value === undefined) return undefined;

            entries.delete(key);
            entries.set(key, value);
            return value;
        },
        set: (key, value) => {
            entries.delete(key);
            entries.set(key, value);

            const oldest = entries.keys().next();
            if (entries.size > capacity && !oldest.done) entries.delete(oldest.value);
        },
        delete: (key) => {
            entries.delete(key);
        },
    };
};
