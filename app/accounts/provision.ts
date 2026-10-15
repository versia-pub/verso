import type { Context } from "../kernel/context.ts";
import type { Claims, Issuer } from "../kernel/identity.ts";

/** Mastodon's limit for local usernames. */
const maxUsernameLength = 30;

export type Provisioned =
    | { readonly ok: true; readonly accountId: string; readonly created: boolean }
    | { readonly ok: false; readonly reason: "registration-closed" };

/**
 * Turns a claim into a username Versia allows: letters, digits, `_` and `-`. Accents are dropped
 * rather than the whole letter, so "Zoë" becomes "Zoe". Returns `undefined` if nothing is left.
 */
export const usernameFrom = (claim: unknown): string | undefined => {
    if (typeof claim !== "string") return undefined;

    const username = claim.normalize("NFKD").replace(/[^A-Za-z0-9_-]/g, "");
    return username === "" ? undefined : username;
};

const mayRegister = (registration: Issuer["registration"], claims: Claims): boolean => {
    if (registration === "open") return true;
    if (registration === "closed") return false;

    const value = claims[registration.claim];
    return Array.isArray(value)
        ? value.includes(registration.contains)
        : value === registration.contains;
};

/**
 * Creates a local account named `base`, or `base2`, `base3` and so on if that is taken. Without a
 * base, the names are `user1`, `user2` and so on. The base is shortened to leave room for the
 * number, so every name fits Mastodon's limit.
 */
const createAccount = async (ctx: Context, base: string | undefined): Promise<string> => {
    const id = ctx.ids();

    for (let n = 1;; n++) {
        const suffix = base === undefined || n > 1 ? String(n) : "";
        const username = (base ?? "user").slice(0, maxUsernameLength - suffix.length) + suffix;
        const inserted = await ctx.db.insertInto("accounts")
            .values({
                id,
                username,
                instance_id: null,
                remote_id: null,
                created_at: ctx.clock.now(),
            })
            .onConflict((conflict) => conflict.doNothing())
            .returning("id")
            .executeTakeFirst();

        if (inserted) return id;
    }
};

/**
 * Finds the local account linked to a login, or creates one if the issuer's registration policy
 * allows. Logins are linked by issuer and subject only, never by email, so another issuer can't
 * claim an account by asserting the same address.
 */
export const provision = (ctx: Context, issuer: Issuer, claims: Claims): Promise<Provisioned> =>
    ctx.transaction(async (tx) => {
        const linked = await tx.db.selectFrom("identities")
            .select("account_id")
            .where("issuer", "=", issuer.url)
            .where("subject", "=", claims.sub)
            .executeTakeFirst();

        if (linked) return { ok: true, accountId: linked.account_id, created: false };
        if (!mayRegister(issuer.registration, claims)) {
            return { ok: false, reason: "registration-closed" };
        }

        const accountId = await createAccount(tx, usernameFrom(claims[issuer.username_claim]));
        const identity = await tx.db.insertInto("identities")
            .values({
                issuer: issuer.url,
                subject: claims.sub,
                account_id: accountId,
                created_at: tx.clock.now(),
            })
            .onConflict((conflict) => conflict.doNothing())
            .returning("account_id")
            .executeTakeFirst();

        if (identity) return { ok: true, accountId, created: true };

        // The same login finished first in another request, such as a double-submitted callback.
        // Its account is the user's, so the one made here goes.
        await tx.db.deleteFrom("accounts").where("id", "=", accountId).execute();
        const winner = await tx.db.selectFrom("identities")
            .select("account_id")
            .where("issuer", "=", issuer.url)
            .where("subject", "=", claims.sub)
            .executeTakeFirstOrThrow();

        return { ok: true, accountId: winner.account_id, created: false };
    });
