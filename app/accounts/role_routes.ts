import { VersiaRole } from "@versia/client-api";
import { z } from "zod";
import { NotFound, NotPermitted, ValidationFailed } from "../http/errors.ts";
import { defineRoute, type Route, type RouteViewer } from "../http/route.ts";
import { Flag, Integer, Text } from "../http/schemas.ts";
import type { Context } from "../kernel/context.ts";
import { type AccountRow, findAccount } from "./accounts.ts";
import { Permission } from "../kernel/permissions.ts";
import {
    createRole,
    deleteRole,
    findRole,
    findRoleById,
    grantRole,
    listRoles,
    revokeRole,
    type RoleRow,
    rolesOf,
    updateRole,
} from "./role_queries.ts";
import { refusal, type RoleManager, roleManager } from "./roles.ts";

const Id = z.object({ id: z.string() });
const AccountAndRole = z.object({ id: z.string(), role_id: z.string() });

/** What a role is made of, as clients send it. */
const RoleFields = z.object({
    name: z.string().trim().pipe(z.string().min(1).pipe(Text(128))),
    permissions: z.array(Permission),
    priority: Integer,
    description: z.string().trim().pipe(Text(1024)),
    visible: Flag,
    color: z.union([
        z.literal(""),
        z.string().regex(/^#[0-9a-f]{6}$/i, { error: "Must be a hex colour, such as #ff3838" }),
    ]),
    icon: z.url({ protocol: /^https?$/ }).nullable(),
});

/** A role as Versia's role endpoints show it. */
export const renderVersiaRole = (role: RoleRow): VersiaRole => ({
    id: role.id,
    name: role.name,
    permissions: role.permissions,
    priority: role.priority,
    description: role.description,
    visible: role.visible,
    // Left out when there is none, as Versia Server does.
    icon: role.icon ?? undefined,
    color: role.color,
});

/**
 * The role with this id, if it is below the viewer's highest, so they may change it, and what they
 * may give it.
 */
const managedRole = async (
    ctx: Context,
    viewer: RouteViewer & { accountId: string },
    id: string,
) => {
    const role = await findRoleById(ctx, id);
    if (!role) throw new NotFound();

    const manager = await roleManager(ctx, viewer.accountId, await viewer.permissions());
    const refused = refusal(manager, { priority: role.priority });
    if (refused !== undefined) throw new NotPermitted(refused);

    return { role, manager };
};

/** The local account with this id. Remote accounts aren't shown yet, and have no roles here. */
const localAccount = async (ctx: Context, id: string): Promise<AccountRow> => {
    const account = await findAccount(ctx, id);
    if (account?.domain !== null) throw new NotFound();

    return account;
};

/**
 * Refuses unless `account` is the viewer's own, or ranks below them: its highest role is lower than
 * the viewer's, as with the roles they manage. Or a manager could take roles from their admins.
 */
const checkOutranked = async (
    ctx: Context,
    viewer: RouteViewer & { accountId: string },
    manager: RoleManager,
    account: AccountRow,
) => {
    if (account.id === viewer.accountId) return;

    const highest = (await rolesOf(ctx, account.id))[0]?.priority ?? -Infinity;
    if (highest >= manager.highest) {
        throw new NotPermitted("You can only change the roles of accounts below your highest role");
    }
};

/** Versia Server's role endpoints, which any user may read. */
export const roleRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/roles",
        summary: "Every role, highest priority first",
        tags: ["roles"],
        auth: { require: "user", scope: "read:accounts" },
        responses: { 200: z.array(VersiaRole) },
        handler: async (ctx) => ({
            status: 200,
            body: (await listRoles(ctx)).map(renderVersiaRole),
        }),
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/roles",
        summary: "Creates a role below the viewer's highest, with permissions they have",
        tags: ["roles"],
        auth: { require: "user", scope: "write:accounts", permission: "roles" },
        body: RoleFields.partial().required({ name: true }),
        responses: { 201: VersiaRole },
        handler: async (ctx, { viewer, body }) => {
            const role = {
                ...body,
                permissions: body.permissions ?? [],
                priority: body.priority ?? 0,
            };
            const manager = await roleManager(ctx, viewer.accountId, await viewer.permissions());
            const refused = refusal(manager, role);
            if (refused !== undefined) throw new NotPermitted(refused);

            const created = await createRole(ctx, role);
            if (!created) throw new ValidationFailed({ name: ["A role with this name exists"] });

            return { status: 201, body: renderVersiaRole(created) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/roles/:id",
        summary: "A role",
        tags: ["roles"],
        auth: { require: "user", scope: "read:accounts" },
        params: Id,
        responses: { 200: VersiaRole },
        handler: async (ctx, { params }) => {
            const role = await findRoleById(ctx, params.id);
            if (!role) throw new NotFound();

            return { status: 200, body: renderVersiaRole(role) };
        },
    }),
    defineRoute({
        method: "PATCH",
        path: "/api/v1/roles/:id",
        summary: "Changes a role below the viewer's highest, keeping it there",
        tags: ["roles"],
        auth: { require: "user", scope: "write:accounts", permission: "roles" },
        params: Id,
        body: RoleFields.partial(),
        responses: { 200: VersiaRole },
        handler: async (ctx, { viewer, params, body }) => {
            const { role, manager } = await managedRole(ctx, viewer, params.id);

            // Permissions the role has already may stay, even ones the viewer lacks.
            const added = body.permissions?.filter((permission) =>
                !role.permissions.includes(permission)
            );
            const refused = refusal(manager, { priority: body.priority, permissions: added });
            if (refused !== undefined) throw new NotPermitted(refused);

            const named = body.name === undefined ? undefined : await findRole(ctx, body.name);
            if (named && named.id !== role.id) {
                throw new ValidationFailed({ name: ["A role with this name exists"] });
            }

            const updated = await updateRole(ctx, role.id, body);
            if (!updated) throw new NotFound();

            return { status: 200, body: renderVersiaRole(updated) };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/roles/:id",
        summary: "Deletes a role below the viewer's highest, taking it from everyone who has it",
        tags: ["roles"],
        auth: { require: "user", scope: "write:accounts", permission: "roles" },
        params: Id,
        responses: { 200: z.strictObject({}) },
        handler: async (ctx, { viewer, params }) => {
            const { role } = await managedRole(ctx, viewer, params.id);
            await deleteRole(ctx, role.id);

            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/:id/roles",
        summary: "An account's roles, highest priority first",
        tags: ["roles"],
        auth: { require: "user", scope: "read:accounts" },
        params: Id,
        responses: { 200: z.array(VersiaRole) },
        handler: async (ctx, { params }) => {
            const account = await localAccount(ctx, params.id);

            return { status: 200, body: (await rolesOf(ctx, account.id)).map(renderVersiaRole) };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/accounts/:id/roles/:role_id",
        summary:
            "Gives an account below the viewer a role below their highest, with permissions they have",
        tags: ["roles"],
        auth: { require: "user", scope: "write:accounts", permission: "roles" },
        params: AccountAndRole,
        responses: { 200: z.strictObject({}) },
        handler: async (ctx, { viewer, params }) => {
            const account = await localAccount(ctx, params.id);
            const { role, manager } = await managedRole(ctx, viewer, params.role_id);
            await checkOutranked(ctx, viewer, manager, account);

            // Or anyone with a lower role could give themselves permissions they lack.
            const refused = refusal(manager, { permissions: role.permissions });
            if (refused !== undefined) throw new NotPermitted(refused);

            await grantRole(ctx, account.id, role.id);

            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/accounts/:id/roles/:role_id",
        summary:
            "Takes from an account below the viewer a role below their highest, that an admin gave",
        tags: ["roles"],
        auth: { require: "user", scope: "write:accounts", permission: "roles" },
        params: AccountAndRole,
        responses: { 200: z.strictObject({}) },
        handler: async (ctx, { viewer, params }) => {
            const account = await localAccount(ctx, params.id);
            const { role, manager } = await managedRole(ctx, viewer, params.role_id);
            await checkOutranked(ctx, viewer, manager, account);

            // Roles from an issuer's claims stay, since the next login would give them back.
            await revokeRole(ctx, account.id, role.id);

            return { status: 200, body: {} };
        },
    }),
];
