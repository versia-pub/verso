import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { Text } from "../http/schemas.ts";
import type { Context } from "../kernel/context.ts";
import type { Claims, Issuer } from "../kernel/identity.ts";
import type { Permission } from "../kernel/permissions.ts";
import { claimContains } from "./claims.ts";
import {
    createRole,
    deleteRole,
    findRole,
    findRoleById,
    findRolesByName,
    grantRole,
    type NewRole,
    revokeRole,
    rolePermissionsOf,
    type RoleRow,
    rolesOf,
    setClaimedRoles,
    updateRole,
} from "./role_queries.ts";

const logger = getLogger(["verso", "accounts"]);

/** What an account may do: what every user may, and what each of its roles allows. */
export const accountPermissions = async (
    ctx: Context,
    accountId: string,
    everyUser: readonly Permission[],
): Promise<Set<Permission>> => {
    const roles = await rolePermissionsOf(ctx, accountId);
    return new Set([...everyUser, ...roles.flat()]);
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
    const found = await findRolesByName(ctx, names);

    for (const name of names) {
        if (!found.some((role) => role.name.toLowerCase() === name.toLowerCase())) {
            logger.warn("{issuer} gives the role {role}, which doesn't exist", {
                issuer: issuer.url,
                role: name,
            });
        }
    }

    await setClaimedRoles(ctx, accountId, issuer.url, found.map((role) => role.id));
};

/**
 * What an account may do to roles through the API: change only those below its highest role, and
 * give them only permissions it has itself. Without roles, it may change none.
 */
export type RoleManager = {
    readonly accountId: string;
    readonly highest: number;
    readonly permissions: ReadonlySet<Permission>;
};

export const roleManager = async (
    ctx: Context,
    accountId: string,
    permissions: ReadonlySet<Permission>,
): Promise<RoleManager> => ({
    accountId,
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

/** What a manager's change to roles did, or why it was refused. */
export type Managed<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly reason: "not-found" | "name-taken" }
    | { readonly ok: false; readonly reason: "not-permitted"; readonly description: string };

const notFound = { ok: false, reason: "not-found" } as const;
const nameTaken = { ok: false, reason: "name-taken" } as const;
const notPermitted = (description: string) =>
    ({ ok: false, reason: "not-permitted", description }) as const;

/** A role's name: trimmed, and from 1 to 128 characters, as Versia Server allows. */
export const RoleName: z.ZodType<string, string> = z.string().trim().pipe(
    z.string().min(1, { error: "A role needs a name" }).pipe(Text(128)),
);

/** The role with this id, if `manager` may change it: it is below their highest. */
const managedRole = async (
    ctx: Context,
    manager: RoleManager,
    id: string,
): Promise<Managed<RoleRow>> => {
    const role = await findRoleById(ctx, id);
    if (!role) return notFound;

    const refused = refusal(manager, { priority: role.priority });
    return refused === undefined ? { ok: true, value: role } : notPermitted(refused);
};

/** Creates a role, if it is below the manager's highest and gives only what they have. */
export const createManagedRole = async (
    ctx: Context,
    manager: RoleManager,
    role: NewRole,
): Promise<Managed<RoleRow>> => {
    const refused = refusal(manager, role);
    if (refused !== undefined) return notPermitted(refused);

    const created = await createRole(ctx, role);
    return created ? { ok: true, value: created } : nameTaken;
};

/**
 * Changes a role below the manager's highest, keeping it there. Permissions the role has already
 * may stay, even ones the manager lacks; only the ones added must be theirs.
 */
export const updateManagedRole = async (
    ctx: Context,
    manager: RoleManager,
    id: string,
    changes: Partial<NewRole>,
): Promise<Managed<RoleRow>> => {
    const found = await managedRole(ctx, manager, id);
    if (!found.ok) return found;

    const role = found.value;
    const added = changes.permissions?.filter((permission) =>
        !role.permissions.includes(permission)
    );
    const refused = refusal(manager, { priority: changes.priority, permissions: added });
    if (refused !== undefined) return notPermitted(refused);

    const named = changes.name === undefined ? undefined : await findRole(ctx, changes.name);
    if (named && named.id !== role.id) return nameTaken;

    const updated = await updateRole(ctx, role.id, changes);
    return updated ? { ok: true, value: updated } : notFound;
};

/** Deletes a role below the manager's highest, taking it from everyone who has it. */
export const deleteManagedRole = async (
    ctx: Context,
    manager: RoleManager,
    id: string,
): Promise<Managed<undefined>> => {
    const found = await managedRole(ctx, manager, id);
    if (!found.ok) return found;

    await deleteRole(ctx, id);
    return { ok: true, value: undefined };
};

/**
 * Gives an account a role, or takes away one an admin gave, if the role is below the manager's
 * highest, and the account is their own or ranks below them; or a manager could take roles from
 * their admins. Giving one also needs its permissions to be the manager's, or anyone with a lower
 * role could give themselves permissions they lack. Roles from an issuer's claims stay, since the
 * next login would give them back.
 */
export const changeManagedRole = async (
    ctx: Context,
    manager: RoleManager,
    change: { readonly accountId: string; readonly roleId: string; readonly give: boolean },
): Promise<Managed<undefined>> => {
    const found = await managedRole(ctx, manager, change.roleId);
    if (!found.ok) return found;

    if (change.accountId !== manager.accountId) {
        const highest = (await rolesOf(ctx, change.accountId))[0]?.priority ?? -Infinity;
        if (highest >= manager.highest) {
            return notPermitted(
                "You can only change the roles of accounts below your highest role",
            );
        }
    }

    if (change.give) {
        const refused = refusal(manager, { permissions: found.value.permissions });
        if (refused !== undefined) return notPermitted(refused);

        await grantRole(ctx, change.accountId, change.roleId);
    } else {
        await revokeRole(ctx, change.accountId, change.roleId);
    }

    return { ok: true, value: undefined };
};
