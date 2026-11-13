/**
 * `verso admin users …`.
 * @module
 */
import { Command } from "@cliffy/command";
import { findLocalAccount } from "../accounts/account_queries.ts";
import { findRole } from "../accounts/role_queries.ts";
import { grantRoleTo, revokeRoleFrom } from "../accounts/roles.ts";
import type { Context } from "../kernel/context.ts";
import { AdminError, type AdminIo, missingCommand } from "./admin_io.ts";

/** A local account and a role, both by name, or an error saying which one doesn't exist. */
const accountAndRole = async (ctx: Context, username: string, roleName: string) => {
    const account = await findLocalAccount(ctx, username);
    if (!account) throw new AdminError(`There is no local account named ${username}`);

    const role = await findRole(ctx, roleName);
    if (!role) throw new AdminError(`There is no role named ${roleName}`);

    return { account, role };
};

/** The `users` group of commands. */
export const usersCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description("Manage local accounts.")
        .action(missingCommand)
        .command("grant-role <username:string> <role:string>", "Give an account a role.")
        .action(async ({ config }, username, roleName) => {
            const result = await io.withContext(config, async (ctx) => {
                const { account, role } = await accountAndRole(ctx, username, roleName);
                const changed = await grantRoleTo(ctx, account.id, role.id);

                return { username: account.username, role: role.name, changed };
            });
            io.print(JSON.stringify(result));
        })
        .command(
            "revoke-role <username:string> <role:string>",
            "Take away a role an admin gave an account.",
        )
        .action(async ({ config }, username, roleName) => {
            const result = await io.withContext(config, async (ctx) => {
                const { account, role } = await accountAndRole(ctx, username, roleName);
                const changed = await revokeRoleFrom(ctx, account.id, role.id);

                return { username: account.username, role: role.name, changed };
            });
            io.print(JSON.stringify(result));
        })
        .reset();
