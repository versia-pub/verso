import { v0_7 } from "@versia/protocol";
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
 * References to `rows`, in the form Verso sends: `domain:id`, with the domain of this instance for a
 * local entity. A remote entity whose remote id Verso doesn't know is omitted.
 */
export const referencesTo = (ctx: Context, rows: readonly EntityRow[]): string[] =>
    rows.flatMap((row) => {
        if (row.domain === null) {
            return [v0_7.formatReference({ host: ctx.urls.domain, id: row.id })];
        }
        return row.remote_id === null
            ? []
            : [v0_7.formatReference({ host: row.domain, id: row.remote_id })];
    });
