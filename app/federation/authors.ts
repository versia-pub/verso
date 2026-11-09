/**
 * Who Versia entities are by, so that what suspended users made is neither served, sent, nor
 * accepted.
 * @module
 */
import { parseReference } from "@versia/protocol";
import { isSuspended } from "../accounts/account_queries.ts";
import type { Context } from "../kernel/context.ts";

/**
 * The reference to the user an entity, or a page of a collection, is by: a User's own id, or its
 * `author`. `undefined` if it names none.
 */
export const authorOf = (entity: unknown): string | undefined => {
    if (typeof entity !== "object" || entity === null) return undefined;
    const { type, id, author } = entity as Record<string, unknown>;
    const reference = type === "User" ? id : author;

    return typeof reference === "string" ? reference : undefined;
};

/** Whether `entity`, from the instance `origin`, is by a user Verso has suspended. */
export const bySuspendedUser = async (
    ctx: Context,
    entity: unknown,
    origin: string,
): Promise<boolean> => {
    const reference = authorOf(entity);
    const author = reference === undefined ? undefined : parseReference(reference, origin);
    if (author === undefined) return false;

    return await isSuspended(
        ctx,
        author.host === ctx.urls.domain ? null : author.host,
        author.id,
    );
};
