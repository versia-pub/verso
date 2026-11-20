import { v0_7 } from "@versia/protocol";
import type { Budget, Context } from "../kernel/context.ts";

/** The host of the instance that may send `entity`: its author's. */
export const authorityOf = (entity: { readonly author: string }): string | undefined =>
    v0_7.parseReference(entity.author)?.host;

/** Fetches the author of `entity`, which is often new to Verso, if it isn't known already. */
export const resolveAuthor = async (
    ctx: Context,
    entity: { readonly author: string },
    budget: Budget,
): Promise<void> => {
    const author = v0_7.parseReference(entity.author);
    if (author) await ctx.federation.resolve(ctx, author, "User", budget);
};
