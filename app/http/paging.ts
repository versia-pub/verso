/**
 * Paging through lists as Mastodon does: newest first, by the cursors in each page's `Link` header.
 * @see https://docs.joinmastodon.org/api/guidelines/#pagination
 * @module
 */
import { z } from "zod";
import type { Cursors } from "./route.ts";
import { Integer } from "./schemas.ts";

type PageFields = {
    max_id: z.ZodOptional<z.ZodString>;
    since_id: z.ZodOptional<z.ZodString>;
    min_id: z.ZodOptional<z.ZodString>;
    limit: z.ZodType<number, number | string | undefined>;
};

/**
 * Which page of a list to return: what is older than `max_id`, newer than `since_id`, or just newer
 * than `min_id`, at most `limit` of it. Clients may request more than `max`, and get `max`.
 */
export const PageQuery = (
    limit: { readonly default: number; readonly max: number },
): z.ZodObject<PageFields> =>
    z.object({
        max_id: z.string().optional(),
        since_id: z.string().optional(),
        min_id: z.string().optional(),
        limit: Integer.pipe(z.int().min(0)).optional()
            .transform((asked) => Math.max(1, Math.min(asked ?? limit.default, limit.max))),
    });

/** A page of a list, as requested. */
export type PageQuery = z.output<ReturnType<typeof PageQuery>>;

/**
 * Where the pages before and after `items` start, given each item's cursor, which may be a
 * different id than the item's own. There is an older page only if this one is full.
 */
export const cursorsOf = <T>(
    items: readonly T[],
    page: PageQuery,
    cursor: (item: T) => string,
): Cursors => {
    const newest = items.at(0);
    const oldest = items.at(-1);

    return {
        newer: newest && cursor(newest),
        older: oldest && items.length >= page.limit ? cursor(oldest) : undefined,
    };
};

/**
 * The `Link` header for a page at `url`, with the cursors in place of the ones it was requested
 * with, or `undefined` if it links nowhere.
 */
export const linkHeader = (url: URL, cursors: Cursors): string | undefined => {
    const at = (key: "max_id" | "min_id", cursor: string) => {
        const linked = new URL(url);
        for (const name of ["max_id", "since_id", "min_id"]) linked.searchParams.delete(name);
        linked.searchParams.set(key, cursor);

        return linked.href;
    };

    const links = [
        cursors.older === undefined ? undefined : `<${at("max_id", cursors.older)}>; rel="next"`,
        cursors.newer === undefined ? undefined : `<${at("min_id", cursors.newer)}>; rel="prev"`,
    ].filter((link) => link !== undefined);

    return links.length > 0 ? links.join(", ") : undefined;
};
