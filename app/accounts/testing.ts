import type { Context } from "../kernel/context.ts";
import type { Permission } from "./permissions.ts";

/** A local account, for tests that skip logging in. Its id is its username. */
export const createLocalAccount = async (ctx: Context, username: string): Promise<string> => {
    await ctx.db.insertInto("accounts")
        .values({
            id: username,
            username,
            instance_id: null,
            remote_id: null,
            created_at: ctx.clock.now(),
        })
        .execute();

    return username;
};

/** A role with these permissions. Its id is its name. */
export const createRole = async (
    ctx: Context,
    name: string,
    permissions: Permission[],
): Promise<string> => {
    await ctx.db.insertInto("roles")
        .values({ id: name, name, permissions, created_at: ctx.clock.now() })
        .execute();

    return name;
};

/** Gives an account a role, as an admin would, or as an issuer's claims would. */
export const giveRole = async (
    ctx: Context,
    accountId: string,
    roleId: string,
    issuer: string | null = null,
): Promise<void> => {
    await ctx.db.insertInto("account_roles")
        .values({ account_id: accountId, role_id: roleId, issuer, created_at: ctx.clock.now() })
        .execute();
};
