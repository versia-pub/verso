/**
 * Finding what a URL names when a search is asked to resolve it: a Versia User or Note at its
 * entity URL, which is the `uri` Verso shows for an account or status. It is fetched if Verso
 * doesn't have it.
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/services/resolve_url_service.rb
 * @module
 */
import { parseReference } from "@versia/protocol";
import { type AccountRow, findAccounts } from "../accounts/account_queries.ts";
import { isRemoteFailure } from "../federation/resolver.ts";
import type { Budget, Context } from "../kernel/context.ts";
import type { NoteRow } from "../notes/note_queries.ts";
import { visibleNote } from "../notes/visibility.ts";

/** Whether `query` is a URL, which a search that resolves finds alone. */
export const isUrlQuery = (query: string): boolean => /^https?:\/\//.test(query);

const entityPath = /^\/\.versia\/v0\.6\/entities\/(User|Note)\/([A-Za-z0-9_-]+)$/;

/** The User or Note at the entity URL `text`, if it is one. */
const entityAt = (text: string) => {
    const url = URL.parse(text);
    if (url === null) return undefined;

    const match = entityPath.exec(url.pathname);
    if (match === null) return undefined;

    const [, name, id] = match;
    const type: "User" | "Note" = name === "User" ? "User" : "Note";
    const reference = parseReference(id, url.host);
    return reference && { type, reference };
};

/** What a URL names: an account or a status. */
export type UrlResource =
    | { readonly type: "accounts"; readonly account: AccountRow }
    | { readonly type: "statuses"; readonly note: NoteRow };

/**
 * The id of the User or Note at the entity URL `url`, fetched if Verso doesn't have it, from
 * `budget` if given. A remote instance that fails finds nothing.
 */
export const resolveEntityAt = async (
    ctx: Context,
    url: string,
    budget?: Budget,
): Promise<{ readonly type: "User" | "Note"; readonly id: string } | undefined> => {
    const entity = entityAt(url);
    if (entity === undefined) return undefined;

    try {
        const id = await ctx.federation.resolve(ctx, entity.reference, entity.type, budget);
        return id === undefined ? undefined : { type: entity.type, id };
    } catch (error) {
        if (!isRemoteFailure(error)) throw error;
        return undefined;
    }
};

/**
 * The account or status at the entity URL `url`, fetched if Verso doesn't have it, if `viewerId`
 * may see it. A remote instance that fails finds nothing.
 */
export const resolveUrl = async (
    ctx: Context,
    url: string,
    viewerId: string,
): Promise<UrlResource | undefined> => {
    const entity = await resolveEntityAt(ctx, url);
    if (entity === undefined) return undefined;
    const { id } = entity;

    if (entity.type === "User") {
        const [account] = await findAccounts(ctx, [id]);
        return account && { type: "accounts", account };
    }

    const note = await visibleNote(ctx, id, viewerId);
    return note && { type: "statuses", note };
};
