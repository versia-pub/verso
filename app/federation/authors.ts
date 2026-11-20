/**
 * Who Versia entities are by, so that what suspended users made is neither served, sent, nor
 * accepted.
 * @module
 */
import { v0_7 } from "@versia/protocol";
import { hasLocalUser, isSuspended } from "../accounts/account_queries.ts";
import type { Context } from "../kernel/context.ts";

/**
 * The reference to the user an entity, or a page of a collection, is by: a User's own id, or its
 * `author`. A subscription entity has none, so it is by its `subscriber`, or by its `target` if
 * that answers. `undefined` if it names none.
 */
export const authorOf = (entity: unknown): string | undefined => {
    if (typeof entity !== "object" || entity === null) return undefined;
    const { type, id, author, subscriber, target } = entity as Record<string, unknown>;

    let reference = author;
    if (type === "User") reference = id;
    else if (type === "Subscribe" || type === "Unsubscribe") reference = subscriber;
    else if (type === "SubscribeAccept" || type === "SubscribeReject") reference = target;

    return typeof reference === "string" ? reference : undefined;
};

/**
 * The user `entity`, or a page of a collection, from the instance `origin`, is by. A User's own id
 * and a page's `author` are bare ids on `origin`, since only references to other entities carry a
 * domain.
 */
export const authorReference = (entity: unknown, origin: string): v0_7.Reference | undefined => {
    const text = authorOf(entity);
    if (text === undefined) return undefined;

    return v0_7.parseReference(text.includes(":") ? text : `${origin}:${text}`);
};

/**
 * Whether `entity`, made here, is by a local user Verso no longer has, like one removed since.
 */
export const byRemovedUser = async (ctx: Context, entity: unknown): Promise<boolean> => {
    const author = authorReference(entity, ctx.urls.domain);
    if (author?.host !== ctx.urls.domain) return false;

    return !await hasLocalUser(ctx, author.id);
};

/** Whether `entity`, from the instance `origin`, is by a user Verso has suspended. */
export const bySuspendedUser = async (
    ctx: Context,
    entity: unknown,
    origin: string,
): Promise<boolean> => {
    const author = authorReference(entity, origin);
    if (author === undefined) return false;

    return await isSuspended(
        ctx,
        author.host === ctx.urls.domain ? null : author.host,
        author.id,
    );
};
