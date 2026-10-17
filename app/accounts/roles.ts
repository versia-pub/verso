import { getLogger } from "@logtape/logtape";
import type { Context } from "../kernel/context.ts";
import type { Claims, Issuer } from "../kernel/identity.ts";
import type { Permission } from "../kernel/permissions.ts";
import { claimContains } from "./claims.ts";
import { findRolesByName, rolePermissionsOf, rolesOf, setClaimedRoles } from "./role_queries.ts";

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
