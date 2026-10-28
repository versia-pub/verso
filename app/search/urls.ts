/**
 * Finding what a URL names, as Mastodon's search does when asked to resolve it: a Versia User or
 * Note at its entity URL, which is the `uri` Verso shows for an account or status, fetched if Verso
 * doesn't have it.
 * @see https://github.com/mastodon/mastodon/blob/main/app/services/resolve_url_service.rb
 * @module
 */
import { parseReference } from "@versia/protocol";
import { type AccountRow, findAccounts } from "../accounts/account_queries.ts";
import { isRemoteFailure } from "../federation/resolver.ts";
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "../notes/note_queries.ts";
import { visibleNote } from "../notes/visibility.ts";

/** Whether `query` is a URL, which a search that resolves finds alone, as on Mastodon. */
export const isUrlQuery = (query: string): boolean => /^https?:\/\//.test(query);

const entityPath = /^\/\.versia\/v0\.6\/entities\/(User|Note)\/([A-Za-z0-9_-]+)$/;

/** The User or Note at the entity URL `text`, if it is one. */
const entityAt = (text: string) => {
    const url = URL.parse(text);
    if (url === null) return undefined;

    const match = entityPath.exec(url.pathname);
    if (match === null) return undefined;

    const [, type, id] = match;
    const reference = parseReference(id, url.host);
    return reference && { type, reference };
};

/** What a URL names: an account or a status. */
export type UrlResource =
    | { readonly type: "accounts"; readonly account: AccountRow }
    | { readonly type: "statuses"; readonly note: NoteRow };

/**
 * The account or status at the entity URL `url`, fetched if Verso doesn't have it, if `viewerId`
 * may see it. A remote instance that fails finds nothing.
 */
export const resolveUrl = async (
    ctx: Context,
    url: string,
    viewerId: string,
): Promise<UrlResource | undefined> => {
    const entity = entityAt(url);
    if (entity === undefined) return undefined;

    let id: string | undefined;
    try {
        id = await ctx.federation.resolve(ctx, entity.reference, entity.type);
    } catch (error) {
        if (!isRemoteFailure(error)) throw error;
        return undefined;
    }
    if (id === undefined) return undefined;

    if (entity.type === "User") {
        const [account] = await findAccounts(ctx, [id]);
        return account && { type: "accounts", account };
    }

    const note = await visibleNote(ctx, id, viewerId);
    return note && { type: "statuses", note };
};
