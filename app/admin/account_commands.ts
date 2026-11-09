/**
 * `verso admin accounts …`.
 * @module
 */
import { Command } from "@cliffy/command";
import { findAccountByAddress, parseAddress } from "../accounts/addresses.ts";
import type { Context } from "../kernel/context.ts";
import { suspend, unsuspend } from "../moderation/suspensions.ts";
import { AdminError, type AdminIo, missingCommand } from "./admin_io.ts";

/** The account at `acct`, `username` or `username@domain`, or an error saying there is none. */
const accountAt = async (ctx: Context, acct: string) => {
    const address = parseAddress(ctx, acct);
    const account = address && await findAccountByAddress(ctx, address, { fetch: false });
    if (!account) throw new AdminError(`There is no account ${acct}`);

    return account;
};

/** Suspends the account at `acct`, or lifts its suspension, and prints whether that changed it. */
const suspension =
    (io: AdminIo, suspended: boolean) => async ({ config }: { config: string }, acct: string) => {
        const result = await io.withContext(config, async (ctx) => {
            const account = await accountAt(ctx, acct);
            const changed = await (suspended ? suspend : unsuspend)(ctx, account.id);
            const name = account.domain === null
                ? account.username
                : `${account.username}@${account.domain}`;

            return { account: name, suspended, changed };
        });
        io.print(JSON.stringify(result));
    };

/** The `accounts` group of commands. */
export const accountsCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description("Moderate accounts, local or remote.")
        .action(missingCommand)
        .command("suspend <acct:string>", "Suspend an account, keeping all it has.")
        .action(suspension(io, true))
        .command("unsuspend <acct:string>", "Lift an account's suspension.")
        .action(suspension(io, false))
        .reset();
