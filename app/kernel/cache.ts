/**
 * Values that rarely change but are read often, such as the blocked domains, kept in this process
 * for a while rather than read on every use.
 * @module
 */
import type { Clock } from "./clock.ts";

/** A value kept for a while, as {@link cached} keeps it. */
export type Cached<C, T> = {
    /** The value, worked out with `ctx` if it isn't kept, or was kept too long. */
    readonly get: (ctx: C) => Promise<T>;
    /** Forgets the value, so the next `get` works it out again, such as after it changed. */
    readonly clear: () => void;
};

/**
 * Keeps what `load` gives for `ttlMs`, by the context's clock. Gets while it loads share one load,
 * and a load that fails isn't kept.
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
