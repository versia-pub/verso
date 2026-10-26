import { formatReference } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";

/**
 * A local or remote entity, with its local id, its id on its instance, and that instance's domain.
 */
export type EntityRow = {
    readonly id: string;
    readonly remote_id: string | null;
    /** `null` for a local entity. */
    readonly domain: string | null;
};

/**
 * References to `rows`, as Verso puts them in what it sends: a bare id for a local entity, and the
 * host and id for a remote one, which is omitted if Verso doesn't know its remote id.
 */
export const referencesTo = (ctx: Context, rows: readonly EntityRow[]): string[] =>
    rows.flatMap((row) => {
        if (row.domain === null) return [row.id];
        return row.remote_id === null
            ? []
            : [formatReference({ host: row.domain, id: row.remote_id }, ctx.urls.domain)];
    });
