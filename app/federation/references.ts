import { formatReference } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";

/** A local or remote entity, by its id here, its id on its instance, and that instance's domain. */
export type EntityRow = {
    readonly id: string;
    readonly remote_id: string | null;
    /** `null` for a local one. */
    readonly domain: string | null;
};

/**
 * References to `rows`, as Verso puts them in what it sends: a bare id for a local one, and the
 * host and id for another instance's, which is left out if Verso doesn't know its id there.
 */
export const referencesTo = (ctx: Context, rows: readonly EntityRow[]): string[] =>
    rows.flatMap((row) => {
        if (row.domain === null) return [row.id];
        return row.remote_id === null
            ? []
            : [formatReference({ host: row.domain, id: row.remote_id }, ctx.urls.domain)];
    });
