import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { Permission } from "../kernel/permissions.ts";
import type { RolesTable } from "./tables.ts";

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

/** Updates a role, and returns it as it is now, or `undefined` if there is no such role. */
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

/** Deletes a role, and removes it from everyone. */
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

/**
 * Grants an account a role, as an admin. Returns whether the account didn't already have it from an
 * admin.
 */
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
 * Revokes a role that an admin granted an account. Returns whether it had it. A role granted by its
 * issuer's claims stays, since the next login would grant it again.
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

/** The roles an account has, from any source, each once, highest priority first. */
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

/** The roles of each of `accountIds`, by account, highest priority first. */
export const rolesOfAccounts = async (
    ctx: Context,
    accountIds: readonly string[],
): Promise<Map<string, RoleRow[]>> => {
    const roles = new Map<string, RoleRow[]>();
    if (accountIds.length === 0) return roles;

    const rows = await ctx.db.selectFrom("account_roles")
        .innerJoin("roles", "roles.id", "account_roles.role_id")
        .selectAll("roles")
        .select("account_roles.account_id")
        .where("account_roles.account_id", "in", accountIds)
        .orderBy("roles.priority", "desc")
        .orderBy("roles.name")
        .execute();

    for (const { account_id, ...role } of rows) {
        const held = roles.get(account_id) ?? [];
        // An account may hold a role from several sources, but has it once.
        if (!held.some((other) => other.id === role.id)) held.push(role);
        roles.set(account_id, held);
    }

    return roles;
};

/** Every role, highest priority first. */
export const listRoles = async (ctx: Context): Promise<RoleRow[]> =>
    await ctx.db.selectFrom("roles").selectAll().orderBy("priority", "desc").orderBy("name")
        .execute();

/** The permissions of each role an account has, from any source. */
export const rolePermissionsOf = async (
    ctx: Context,
    accountId: string,
): Promise<Permission[][]> => {
    const roles = await ctx.db.selectFrom("account_roles")
        .innerJoin("roles", "roles.id", "account_roles.role_id")
        .select("roles.permissions")
        .where("account_roles.account_id", "=", accountId)
        .execute();

    return roles.map((role) => role.permissions);
};

/** The roles with these names, in any case. */
export const findRolesByName = async (
    ctx: Context,
    names: readonly string[],
): Promise<Pick<RoleRow, "id" | "name">[]> =>
    names.length === 0 ? [] : await ctx.db.selectFrom("roles")
        .select(["id", "name"])
        .where((eb) => eb(eb.fn("lower", ["name"]), "in", names.map((name) => name.toLowerCase())))
        .execute();

/**
 * Sets the roles that `issuer` grants an account to exactly `roleIds`, revoking the others it
 * granted. Roles from an admin or another issuer stay.
 */
export const setClaimedRoles = async (
    ctx: Context,
    accountId: string,
    issuer: string,
    roleIds: readonly string[],
): Promise<void> => {
    await ctx.db.deleteFrom("account_roles")
        .where("account_id", "=", accountId)
        .where("issuer", "=", issuer)
        .$if(roleIds.length > 0, (query) => query.where("role_id", "not in", roleIds))
        .execute();

    if (roleIds.length === 0) return;

    await ctx.db.insertInto("account_roles")
        .values(roleIds.map((roleId) => ({
            account_id: accountId,
            role_id: roleId,
            issuer,
            created_at: ctx.clock.now(),
        })))
        .onConflict((conflict) => conflict.doNothing())
        .execute();
};
