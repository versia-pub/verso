import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { Text } from "../http/schemas.ts";
import type { Context } from "../kernel/context.ts";
import type { Claims, Issuer } from "../kernel/identity.ts";
import type { Permission } from "../kernel/permissions.ts";
import { type Channel, publish, subscribe } from "../kernel/pubsub.ts";
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

/**
 * Says an account's roles changed, or with no account, that a role did, so what anyone may do may
 * have, and every process looks it up again for what it keeps open, such as streams.
 */
const rolesChanged: Channel<{ readonly accountId: string | null }> = {
    name: "roles.changed",
    schema: z.object({ accountId: z.string().nullable() }),
};

/**
 * Calls `onChanged` once what `accountId` may do may have changed, until the function returned is
 * called. A process that may have missed being told calls it too.
 */
export const watchRoles = (ctx: Context, accountId: string, onChanged: () => void): () => void => {
    const unsubscribe = subscribe(ctx, rolesChanged, (message) => {
        if (message.accountId === null || message.accountId === accountId) onChanged();
        return Promise.resolve();
    });
    const unwatch = ctx.pubsub.onMissed(() => Promise.resolve(onChanged()));

    return () => {
        unsubscribe();
        unwatch();
    };
};

/** Gives an account a role, as an admin. Returns whether it didn't already have it from one. */
export const grantRoleTo = async (
    ctx: Context,
    accountId: string,
    roleId: string,
): Promise<boolean> => {
    const given = await grantRole(ctx, accountId, roleId);
    if (given) await publish(ctx, rolesChanged, { accountId });

    return given;
};

/** Takes away a role an admin gave an account. Returns whether it had it. */
export const revokeRoleFrom = async (
    ctx: Context,
    accountId: string,
    roleId: string,
): Promise<boolean> => {
    const taken = await revokeRole(ctx, accountId, roleId);
    if (taken) await publish(ctx, rolesChanged, { accountId });

    return taken;
};

/** What an account may do: what every user may do, and what each of its roles allows. */
export const accountPermissions = async (
    ctx: Context,
    accountId: string,
    everyUser: readonly Permission[],
): Promise<Set<Permission>> => {
    const roles = await rolePermissionsOf(ctx, accountId);
    return new Set([...everyUser, ...roles.flat()]);
};

/**
 * Grants an account the roles that the issuer's rules match in a login's claims, and revokes the
 * ones the issuer granted before that no longer match. Roles granted by an admin or another issuer
 * stay. Rules naming a role that doesn't exist are skipped, with a warning.
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
    await publish(ctx, rolesChanged, { accountId });
};

/**
 * What an account may do to roles through the API: change only those below its highest role, and
 * grant them only permissions it has itself. Without roles, it may change none.
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

/** Why `manager` may not create a role with this priority and these permissions, if it may not. */
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

/** The outcome of a manager's change to roles, or why it was rejected. */
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

/** Creates a role, if it is below the manager's highest and grants only permissions they have. */
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
 * Updates a role below the manager's highest, keeping it there. Permissions the role already has
 * may stay, even ones the manager lacks; only the added ones must be the manager's.
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

    const takenBy = async (name: string | undefined) => {
        const named = name === undefined ? undefined : await findRole(ctx, name);
        return named !== undefined && named.id !== role.id;
    };
    if (await takenBy(changes.name)) return nameTaken;

    let updated;
    try {
        updated = await updateRole(ctx, role.id, changes);
    } catch (error) {
        // Another role may have taken the name since it was checked.
        if (await takenBy(changes.name)) return nameTaken;
        throw error;
    }
    if (!updated) return notFound;

    if (changes.permissions !== undefined) await publish(ctx, rolesChanged, { accountId: null });
    return { ok: true, value: updated };
};

/** Deletes a role below the manager's highest, removing it from everyone who has it. */
export const deleteManagedRole = async (
    ctx: Context,
    manager: RoleManager,
    id: string,
): Promise<Managed<undefined>> => {
    const found = await managedRole(ctx, manager, id);
    if (!found.ok) return found;

    await deleteRole(ctx, id);
    await publish(ctx, rolesChanged, { accountId: null });
    return { ok: true, value: undefined };
};

/**
 * Grants an account a role, or revokes one that an admin granted, if the role is below the
 * manager's highest and the account is their own or ranks below them; otherwise a manager could
 * take roles from their admins. Granting a role also requires its permissions to be the manager's,
 * or anyone with a lower role could grant themselves permissions they lack. Roles from an issuer's
 * claims stay, since the next login would grant them again.
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

        await grantRoleTo(ctx, change.accountId, change.roleId);
    } else {
        await revokeRoleFrom(ctx, change.accountId, change.roleId);
    }

    return { ok: true, value: undefined };
};
