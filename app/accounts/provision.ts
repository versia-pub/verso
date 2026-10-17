import type { Context } from "../kernel/context.ts";
import type { Claims, Issuer } from "../kernel/identity.ts";
import {
    deleteAccount,
    insertLocalAccount,
    linkedAccount,
    linkIdentity,
    localUsernamesStartingWith,
} from "./accounts.ts";
import { claimContains } from "./claims.ts";
import { syncClaimedRoles } from "./roles.ts";

/** Mastodon's limit for local usernames. */
const maxUsernameLength = 30;

/** Mastodon's limit for display names, in characters. */
const maxDisplayNameLength = 30;

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

/**
 * Turns a claim, such as `name`, into a display name: trimmed, and cut to Mastodon's limit without
 * splitting a character in two. Anything else gives none.
 */
export const displayNameFrom = (claim: unknown): string =>
    typeof claim === "string"
        ? Array.from(claim.trim()).slice(0, maxDisplayNameLength).join("").trim()
        : "";

const mayRegister = (registration: Issuer["registration"], claims: Claims): boolean => {
    if (registration === "open") return true;
    if (registration === "closed") return false;

    return claimContains(claims, registration);
};

/**
 * The `n`th username to try for `base`: `base`, `base2`, `base3` and so on, or without a base,
 * `user1`, `user2` and so on. The base is shortened to leave room for the number, so every name fits
 * Mastodon's limit.
 */
const candidate = (base: string | undefined, n: number) => {
    const suffix = base === undefined || n > 1 ? String(n) : "";
    return (base ?? "user").slice(0, maxUsernameLength - suffix.length) + suffix;
};

/**
 * The local usernames, in lowercase, that `base` might become, and some others: every candidate
 * starts with the base cut to leave room for ten digits.
 */
const takenFrom = (ctx: Context, base: string | undefined) =>
    localUsernamesStartingWith(ctx, (base ?? "user").slice(0, maxUsernameLength - 10));

/**
 * Creates a local account with the first free username for `base`, found with one query rather than
 * one insert per number taken.
 */
const createAccount = async (
    ctx: Context,
    base: string | undefined,
    displayName: string,
): Promise<string> => {
    const id = ctx.ids();
    const failed = new Set<string>();

    // Another login may take the name between looking and inserting; then look again.
    for (;;) {
        const taken = await takenFrom(ctx, base);
        const free = (name: string) =>
            !taken.has(name.toLowerCase()) && !failed.has(name.toLowerCase());
        let n = 1;
        while (!free(candidate(base, n))) n++;

        const username = candidate(base, n);
        if (await insertLocalAccount(ctx, { id, username, displayName })) return id;
        failed.add(username.toLowerCase());
    }
};

/**
 * Finds the local account linked to a login, or creates one if the issuer's registration policy
 * allows. Logins are linked by issuer and subject only, never by email, so another issuer can't
 * claim an account by asserting the same address.
 */
const linkAccount = async (tx: Context, issuer: Issuer, claims: Claims): Promise<Provisioned> => {
    const linked = await linkedAccount(tx, issuer.url, claims.sub);
    if (linked !== undefined) return { ok: true, accountId: linked, created: false };
    if (!mayRegister(issuer.registration, claims)) {
        return { ok: false, reason: "registration-closed" };
    }

    const accountId = await createAccount(
        tx,
        usernameFrom(claims[issuer.username_claim]),
        displayNameFrom(claims.name),
    );
    const identity = { issuer: issuer.url, subject: claims.sub, accountId };
    if (await linkIdentity(tx, identity)) return { ok: true, accountId, created: true };

    // The same login finished first in another request, such as a double-submitted callback.
    // Its account is the user's, so the one made here goes.
    await deleteAccount(tx, accountId);
    const winner = await linkedAccount(tx, issuer.url, claims.sub);
    if (winner === undefined) {
        throw new Error(`The login ${claims.sub} at ${issuer.url} wasn't linked`);
    }

    return { ok: true, accountId: winner, created: false };
};

/** Links a login to its account, as `linkAccount` does, and gives it the roles its claims match. */
export const provision = (ctx: Context, issuer: Issuer, claims: Claims): Promise<Provisioned> =>
    ctx.transaction(async (tx) => {
        const provisioned = await linkAccount(tx, issuer, claims);
        if (provisioned.ok) await syncClaimedRoles(tx, issuer, provisioned.accountId, claims);

        return provisioned;
    });
