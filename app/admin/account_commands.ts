/**
 * `verso admin accounts …`.
 * @module
 */
import { Command } from "@cliffy/command";
import { findAccountByAddress, parseAddress } from "../accounts/addresses.ts";
import type { Context } from "../kernel/context.ts";
import { deleteLocalAccount } from "../moderation/account_deletions.ts";
import { silence, unsilence } from "../moderation/silences.ts";
import { suspend, unsuspend } from "../moderation/suspensions.ts";
import { AdminError, type AdminIo, missingCommand } from "./admin_io.ts";

/** The account at `acct`, `username` or `username@domain`, or an error saying there is none. */
const accountAt = async (ctx: Context, acct: string) => {
    const address = parseAddress(ctx, acct);
    const account = address && await findAccountByAddress(ctx, address, { fetch: false });
    if (!account) throw new AdminError(`There is no account ${acct}`);

    return account;
};

/**
 * A command that does `action` to the account at `acct` and prints whether that changed it, with
 * `key` set to `value`.
 */
const moderation = (
    io: AdminIo,
    key: "suspended" | "silenced",
    value: boolean,
    action: (ctx: Context, accountId: string) => Promise<boolean>,
) =>
async ({ config }: { config: string }, acct: string) => {
    const result = await io.withContext(config, async (ctx) => {
        const account = await accountAt(ctx, acct);
        const changed = await action(ctx, account.id);
        const name = account.domain === null
            ? account.username
            : `${account.username}@${account.domain}`;

        return { account: name, [key]: value, changed };
    });
    io.print(JSON.stringify(result));
};

/** The `accounts` group of commands. */
export const accountsCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description("Moderate accounts, local or remote.")
        .action(missingCommand)
        .command("suspend <acct:string>", "Suspend an account, keeping all it has.")
        .action(moderation(io, "suspended", true, suspend))
        .command("unsuspend <acct:string>", "Lift an account's suspension.")
        .action(moderation(io, "suspended", false, unsuspend))
        .command(
            "silence <acct:string>",
            "Silence an account, keeping its statuses out of the public timelines.",
        )
        .action(moderation(io, "silenced", true, silence))
        .command("unsilence <acct:string>", "Lift an account's silence.")
        .action(moderation(io, "silenced", false, unsilence))
        .command(
            "delete <acct:string>",
            "Delete a local account and all it has, keeping it empty so its username and login " +
                "can't be used again.",
        )
        .option(
            "--no-tombstone",
            "Remove the account too, with the reports about it, so its username and login can be " +
                "used again.",
        )
        .action(async ({ config, tombstone }, acct) => {
            const result = await io.withContext(config, async (ctx) => {
                const account = await accountAt(ctx, acct);
                if (account.domain !== null) {
                    throw new AdminError(
                        `${acct} is a remote account, which can be suspended but not deleted`,
                    );
                }

                const changed = await deleteLocalAccount(ctx, account.id, { tombstone });
                return { account: account.username, deleted: true, tombstone, changed };
            });
            io.print(JSON.stringify(result));
        })
        .reset();
