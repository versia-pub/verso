import { VersiaRole } from "@versia/client-api";
import { z } from "zod";
import { NotFound, NotPermitted, ValidationFailed } from "../http/errors.ts";
import { defineRoute, type Route, type RouteViewer } from "../http/route.ts";
import { Flag, Integer, Text } from "../http/schemas.ts";
import type { Context } from "../kernel/context.ts";
import { type AccountRow, findAccount } from "./accounts.ts";
import { Permission } from "../kernel/permissions.ts";
import { findRoleById, listRoles, type RoleRow, rolesOf } from "./role_queries.ts";
import {
    changeManagedRole,
    createManagedRole,
    deleteManagedRole,
    type Managed,
    roleManager,
    RoleName,
    updateManagedRole,
} from "./roles.ts";

const Id = z.object({ id: z.string() });
const AccountAndRole = z.object({ id: z.string(), role_id: z.string() });

/** What a role is made of, as clients send it. */
const RoleFields = z.object({
    name: RoleName,
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

/** The viewer, as a manager of roles. */
const managerOf = async (ctx: Context, viewer: RouteViewer & { accountId: string }) =>
    await roleManager(ctx, viewer.accountId, await viewer.permissions());

/** The result of a change to roles, or the error that says why it was refused. */
const orRefusal = <T>(result: Managed<T>): T => {
    if (result.ok) return result.value;

    switch (result.reason) {
        case "not-found":
            throw new NotFound();
        case "name-taken":
            throw new ValidationFailed({ name: ["A role with this name exists"] });
        case "not-permitted":
            throw new NotPermitted(result.description);
    }
};

/** The local account with this id. Remote accounts aren't shown yet, and have no roles here. */
const localAccount = async (ctx: Context, id: string): Promise<AccountRow> => {
    const account = await findAccount(ctx, id);
    if (account?.domain !== null) throw new NotFound();

    return account;
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
            const created = orRefusal(
                await createManagedRole(ctx, await managerOf(ctx, viewer), role),
            );

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
            const manager = await managerOf(ctx, viewer);
            const updated = orRefusal(await updateManagedRole(ctx, manager, params.id, body));

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
            orRefusal(await deleteManagedRole(ctx, await managerOf(ctx, viewer), params.id));

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
            const change = { accountId: account.id, roleId: params.role_id, give: true };
            orRefusal(await changeManagedRole(ctx, await managerOf(ctx, viewer), change));

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
            const change = { accountId: account.id, roleId: params.role_id, give: false };
            orRefusal(await changeManagedRole(ctx, await managerOf(ctx, viewer), change));

            return { status: 200, body: {} };
        },
    }),
];
