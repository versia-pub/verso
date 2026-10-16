import { getLogger } from "@logtape/logtape";
import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { Claims, Issuer } from "../kernel/identity.ts";
import { claimContains } from "./claims.ts";
import type { Permission } from "./permissions.ts";
import type { RolesTable } from "./tables.ts";

const logger = getLogger(["verso", "accounts"]);

export type RoleRow = Selectable<RolesTable>;

export type NewRole = {
    readonly name: string;
    readonly permissions: readonly Permission[];
    readonly priority: number;
};

/** Creates a role, unless one with its name, in any case, exists. */
export const createRole = async (ctx: Context, role: NewRole): Promise<RoleRow | undefined> =>
    await ctx.db.insertInto("roles")
        .values({
            id: ctx.ids(),
            name: role.name,
            permissions: [...new Set(role.permissions)],
            priority: role.priority,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.doNothing())
        .returningAll()
        .executeTakeFirst();

/** Every role, highest priority first. */
export const listRoles = async (ctx: Context): Promise<RoleRow[]> =>
    await ctx.db.selectFrom("roles").selectAll().orderBy("priority", "desc").orderBy("name")
        .execute();

/** What an account may do: what every user may, and what each of its roles allows. */
export const accountPermissions = async (
    ctx: Context,
    accountId: string,
    everyUser: readonly Permission[],
): Promise<Set<Permission>> => {
    const roles = await ctx.db.selectFrom("account_roles")
        .innerJoin("roles", "roles.id", "account_roles.role_id")
        .select("roles.permissions")
        .where("account_roles.account_id", "=", accountId)
        .execute();

    return new Set([...everyUser, ...roles.flatMap((role) => role.permissions)]);
};

/**
 * Gives an account the roles the issuer's rules match in a login's claims, and takes away the ones
 * the issuer gave before that no longer match. Roles given by an admin or another issuer stay.
 * Rules naming a role that doesn't exist are skipped, with a warning.
 */
export const syncClaimedRoles = async (
    ctx: Context,
    issuer: Issuer,
    accountId: string,
    claims: Claims,
): Promise<void> => {
    const names = [
        ...new Set(
            issuer.roles.filter((rule) => claimContains(claims, rule)).map((rule) => rule.role),
        ),
    ];
    const found = names.length === 0 ? [] : await ctx.db.selectFrom("roles")
        .select(["id", "name"])
        .where((eb) => eb(eb.fn("lower", ["name"]), "in", names.map((name) => name.toLowerCase())))
        .execute();

    for (const name of names) {
        if (!found.some((role) => role.name.toLowerCase() === name.toLowerCase())) {
            logger.warn("{issuer} gives the role {role}, which doesn't exist", {
                issuer: issuer.url,
                role: name,
            });
        }
    }

    const kept = found.map((role) => role.id);
    await ctx.db.deleteFrom("account_roles")
        .where("account_id", "=", accountId)
        .where("issuer", "=", issuer.url)
        .$if(kept.length > 0, (query) => query.where("role_id", "not in", kept))
        .execute();

    if (kept.length === 0) return;

    await ctx.db.insertInto("account_roles")
        .values(kept.map((roleId) => ({
            account_id: accountId,
            role_id: roleId,
            issuer: issuer.url,
            created_at: ctx.clock.now(),
        })))
        .onConflict((conflict) => conflict.doNothing())
        .execute();
};
