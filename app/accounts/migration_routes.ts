import { AccountMigration } from "@versia/client-api";
import { z } from "zod";
import { NotFound, ValidationFailed } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { type AccountRow, findAccount } from "./account_queries.ts";
import { findAccountByAddress, parseAddress } from "./addresses.ts";
import { previousOf, setPrevious } from "./migration.ts";
import { publicAccount } from "./public.ts";

/** The local user `accountId`'s migration, as its owner sees it. */
const ownMigration = async (ctx: Context, accountId: string): Promise<AccountMigration> => {
    const account = await findAccount(ctx, accountId);
    if (account === undefined) throw new NotFound();

    const previous = await previousOf(ctx, account);
    return { previous: previous === undefined ? null : await publicAccount(ctx, previous) };
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
 * Verso's methods for moving a user from one account to another, which Mastodon only has as
 * settings pages.
 * @see https://versia.pub/extensions/migration
 */
export const migrationRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/migration",
        summary: "Get migration",
        description: "The account the user says they moved from.",
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
];
