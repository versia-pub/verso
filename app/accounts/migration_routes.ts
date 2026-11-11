import { AccountMigration } from "@versia/client-api";
import { z } from "zod";
import { NotFound, ValidationFailed } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { type AccountRow, findAccount } from "./account_queries.ts";
import { findAccountByAddress, parseAddress } from "./addresses.ts";
import { cancelMove, type MoveRefusal, moveTo, previousOf, setPrevious } from "./migration.ts";
import { referenceOf } from "./moves.ts";
import { publicAccount } from "./public.ts";

/** The local user `accountId`'s migration, as its owner sees it. */
const ownMigration = async (ctx: Context, accountId: string): Promise<AccountMigration> => {
    const account = await findAccount(ctx, accountId);
    if (account === undefined) throw new NotFound();

    const previous = await previousOf(ctx, account);
    const moved = account.moved_to_account_id === null
        ? undefined
        : await findAccount(ctx, account.moved_to_account_id);
    return {
        previous: previous === undefined ? null : await publicAccount(ctx, previous),
        moved: moved === undefined ? null : await publicAccount(ctx, moved),
    };
};

/** The account at `acct`, fetched if Verso doesn't have it, other than `accountId`'s own. */
const otherAccount = async (
    ctx: Context,
    accountId: string,
    acct: string,
): Promise<AccountRow> => {
    const address = parseAddress(ctx, acct);
    const account = address && await findAccountByAddress(ctx, address, { fetch: true });
    if (account === undefined) {
        throw new ValidationFailed({ acct: ["No account has this address"] });
    }
    if (account.id === accountId) {
        throw new ValidationFailed({ acct: ["This is your own account"] });
    }

    return account;
};

/**
 * The account at `acct`, other than `accountId`'s own, fetched again just now if it is remote, so
 * that it says what it says now.
 */
const currentAccount = async (
    ctx: Context,
    accountId: string,
    acct: string,
): Promise<AccountRow> => {
    const since = ctx.clock.now();
    const account = await otherAccount(ctx, accountId, acct);
    if (account.domain === null) return account;

    await ctx.federation.resolve(ctx, referenceOf(ctx, account), "User", undefined, 0);
    const fetched = await findAccount(ctx, account.id);
    // A remote account is always saved with the time it was fetched.
    if (fetched === undefined || (fetched.fetched_at ?? new Date(0)) < since) {
        throw new ValidationFailed({ acct: ["The account couldn't be fetched"] });
    }

    return fetched;
};

/** What each refusal to move says. */
const refusals: Record<MoveRefusal, string> = {
    "not-previous": "The account doesn't say you moved from your account",
    unavailable: "The account can't be moved to",
    "moved-there": "You already moved to the account",
    "too-soon": "You can only move once a month",
};

/**
 * Verso's methods for moving a user from one account to another, which Mastodon only has as
 * settings pages.
 * @see https://versia.pub/extensions/migration
 */
export const migrationRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/migration",
        summary: "Get migration",
        description: "The accounts the user says they moved from, and moved to.",
        tags: ["migration"],
        auth: { require: "user", scope: "read:accounts", permission: "owner:account" },
        responses: { 200: AccountMigration },
        handler: async (ctx, { viewer }) => ({
            status: 200,
            body: await ownMigration(ctx, viewer.accountId),
        }),
    }),
    defineRoute({
        method: "PUT",
        path: "/api/v1/migration/previous",
        summary: "Set previous account",
        description:
            "Says the user moved from the account at `acct`, so that it can move to theirs.",
        tags: ["migration"],
        auth: { require: "user", scope: "write:accounts", permission: "owner:account" },
        body: z.object({ acct: z.string() }),
        responses: { 200: AccountMigration },
        handler: async (ctx, { viewer, body }) => {
            const previous = await otherAccount(ctx, viewer.accountId, body.acct);
            await setPrevious(ctx, viewer.accountId, previous);

            return { status: 200, body: await ownMigration(ctx, viewer.accountId) };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/migration/previous",
        summary: "Remove previous account",
        description: "Says the user moved from no account.",
        tags: ["migration"],
        auth: { require: "user", scope: "write:accounts", permission: "owner:account" },
        responses: { 200: AccountMigration },
        handler: async (ctx, { viewer }) => {
            await setPrevious(ctx, viewer.accountId, undefined);

            return { status: 200, body: await ownMigration(ctx, viewer.accountId) };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/migration/move",
        summary: "Move account",
        description:
            "Moves the user to the account at `acct`, which must say it moved from theirs. Their followers follow it instead.",
        tags: ["migration"],
        auth: { require: "user", scope: "write:accounts", permission: "owner:account" },
        body: z.object({ acct: z.string() }),
        responses: { 200: AccountMigration },
        handler: async (ctx, { viewer, body }) => {
            const to = await currentAccount(ctx, viewer.accountId, body.acct);
            const refusal = await moveTo(ctx, viewer.accountId, to);
            if (refusal !== undefined) throw new ValidationFailed({ acct: [refusals[refusal]] });

            return { status: 200, body: await ownMigration(ctx, viewer.accountId) };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/migration/move",
        summary: "Cancel move",
        description:
            "Says the user no longer moved. Their followers that moved stay where they are, and they can't move again until a month after they last did.",
        tags: ["migration"],
        auth: { require: "user", scope: "write:accounts", permission: "owner:account" },
        responses: { 200: AccountMigration },
        handler: async (ctx, { viewer }) => {
            await cancelMove(ctx, viewer.accountId);

            return { status: 200, body: await ownMigration(ctx, viewer.accountId) };
        },
    }),
];
