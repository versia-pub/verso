import { getLogger } from "@logtape/logtape";
import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { Claims, Issuer } from "../kernel/identity.ts";
import { claimContains } from "./claims.ts";
import type { Permission } from "../kernel/permissions.ts";
import type { RolesTable } from "./tables.ts";

const logger = getLogger(["verso", "accounts"]);

export type RoleRow = Selectable<RolesTable>;

export type NewRole = {
    readonly name: string;
    readonly permissions: readonly Permission[];
    readonly priority: number;
    readonly description?: string;
    readonly visible?: boolean;
    readonly color?: string;
    readonly icon?: string | null;
};

/** Creates a role, unless one with its name, in any case, exists. */
export const createRole = async (ctx: Context, role: NewRole): Promise<RoleRow | undefined> =>
    await ctx.db.insertInto("roles")
        .values({
            id: ctx.ids(),
            name: role.name,
            permissions: [...new Set(role.permissions)],
            priority: role.priority,
            description: role.description,
            visible: role.visible,
            color: role.color,
            icon: role.icon,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.doNothing())
        .returningAll()
        .executeTakeFirst();

/** Changes a role, and returns it as it is now, or `undefined` if there is no such role. */
export const updateRole = async (
    ctx: Context,
    id: string,
    changes: Partial<NewRole>,
): Promise<RoleRow | undefined> => {
    const { permissions, ...rest } = changes;
    const values = permissions === undefined
        ? rest
        : { ...rest, permissions: [...new Set(permissions)] };

    if (Object.keys(values).length === 0) return await findRoleById(ctx, id);

    return await ctx.db.updateTable("roles")
        .set(values)
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst();
};

/** Deletes a role, and takes it away from everyone. */
export const deleteRole = async (ctx: Context, id: string): Promise<void> => {
    await ctx.db.deleteFrom("roles").where("id", "=", id).execute();
};

/** The role with this id. */
export const findRoleById = async (ctx: Context, id: string): Promise<RoleRow | undefined> =>
    await ctx.db.selectFrom("roles").selectAll().where("id", "=", id).executeTakeFirst();

/** The role with this name, in any case. */
export const findRole = async (ctx: Context, name: string): Promise<RoleRow | undefined> =>
    await ctx.db.selectFrom("roles")
        .selectAll()
        .where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase()))
        .executeTakeFirst();

/** Gives an account a role, as an admin. Returns whether it didn't have it from an admin yet. */
export const grantRole = async (
    ctx: Context,
    accountId: string,
    roleId: string,
): Promise<boolean> => {
    const granted = await ctx.db.insertInto("account_roles")
        .values({
            account_id: accountId,
            role_id: roleId,
            issuer: null,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning("role_id")
        .executeTakeFirst();

    return granted !== undefined;
};

/**
 * Takes away a role an admin gave an account. Returns whether it had it. A role its issuer's
 * claims gave stays, since the next login would give it back.
 */
export const revokeRole = async (
    ctx: Context,
    accountId: string,
    roleId: string,
): Promise<boolean> => {
    const { numDeletedRows } = await ctx.db.deleteFrom("account_roles")
        .where("account_id", "=", accountId)
        .where("role_id", "=", roleId)
        .where("issuer", "is", null)
        .executeTakeFirstOrThrow();

    return numDeletedRows > 0n;
};

/** The roles an account has, from anyone, each once, highest priority first. */
export const rolesOf = async (ctx: Context, accountId: string): Promise<RoleRow[]> => {
    const given = ctx.db.selectFrom("account_roles")
        .select("role_id")
        .where("account_id", "=", accountId);

    return await ctx.db.selectFrom("roles")
        .selectAll()
        .where("id", "in", given)
        .orderBy("priority", "desc")
        .orderBy("name")
        .execute();
};

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

/**
 * What an account may do to roles through the API: change only those below its highest role, and
 * give them only permissions it has itself. Without roles, it may change none.
 */
export type RoleManager = {
    readonly highest: number;
    readonly permissions: ReadonlySet<Permission>;
};

export const roleManager = async (
    ctx: Context,
    accountId: string,
    permissions: ReadonlySet<Permission>,
): Promise<RoleManager> => ({
    highest: (await rolesOf(ctx, accountId))[0]?.priority ?? -Infinity,
    permissions,
});

/** Why `manager` may not make a role with this priority and these permissions, if it may not. */
export const refusal = (
    manager: RoleManager,
    role: { readonly priority?: number; readonly permissions?: readonly Permission[] },
): string | undefined => {
    if (role.priority !== undefined && role.priority >= manager.highest) {
        return "Roles you manage must have a lower priority than your highest role";
    }

    const missing = role.permissions?.filter((permission) => !manager.permissions.has(permission));
    if (missing !== undefined && missing.length > 0) {
        return `You can't give permissions you don't have: ${missing.join(", ")}`;
    }

    return undefined;
};
