/**
 * Values that rarely change but are read often, such as the blocked domains, cached in this process
 * for a while rather than read on every use.
 * @module
 */
import type { Clock } from "./clock.ts";

/** A value cached for a while, as {@link cached} caches it. */
export type Cached<C, T> = {
    /** The value, computed with `ctx` if it isn't cached, or was cached too long. */
    readonly get: (ctx: C) => Promise<T>;
    /** Clears the value, so the next `get` computes it again, such as after it changed. */
    readonly clear: () => void;
};

/**
 * Caches what `load` returns for `ttlMs`, by the context's clock. Gets while it loads share one
 * load, and a load that fails isn't cached.
 */
export const cached = <C extends { readonly clock: Clock }, T>(
    ttlMs: number,
    load: (ctx: C) => Promise<T>,
): Cached<C, T> => {
    let kept: { readonly value: Promise<T>; readonly until: number } | undefined;

    const clear = () => {
        kept = undefined;
    };

    return {
        get: (ctx) => {
            const now = ctx.clock.now().getTime();
            if (kept !== undefined && kept.until > now) return kept.value;

            const value = load(ctx);
            const entry = { value, until: now + ttlMs };
            kept = entry;
            value.catch(() => {
                if (kept === entry) clear();
            });

            return value;
        },
        clear,
    };
};
