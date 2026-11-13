import { parseReference } from "@versia/protocol";
import type { Sender } from "../federation/registry.ts";
import type { Budget, Context } from "../kernel/context.ts";

/** The host of the instance that may send `entity`: its author's. */
export const authorityOf = (
    entity: { readonly author: string },
    origin: string,
): string | undefined => parseReference(entity.author, origin)?.host;

/** Fetches the author of `entity`, which is often new to Verso, if it isn't known already. */
export const resolveAuthor = async (
    ctx: Context,
    entity: { readonly author: string },
    sender: Sender,
    budget: Budget,
): Promise<void> => {
    const author = parseReference(entity.author, sender.domain);
    if (author) await ctx.federation.resolve(ctx, author, "User", budget);
};
