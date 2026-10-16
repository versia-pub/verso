import { VersiaRole } from "@versia/client-api";
import { z } from "zod";
import { NotFound, NotPermitted, ValidationFailed } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag, Integer, Text } from "../http/schemas.ts";
import { findAccount } from "./accounts.ts";
import { Permission } from "./permissions.ts";
import {
    createRole,
    findRoleById,
    listRoles,
    refusal,
    roleManager,
    type RoleRow,
    rolesOf,
} from "./roles.ts";

const Id = z.object({ id: z.string() });

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
        method: "GET",
        path: "/api/v1/accounts/:id/roles",
        summary: "An account's roles, highest priority first",
        tags: ["roles"],
        auth: { require: "user", scope: "read:accounts" },
        params: Id,
        responses: { 200: z.array(VersiaRole) },
        handler: async (ctx, { params }) => {
            // Remote accounts aren't shown yet, and have no roles here anyway.
            const account = await findAccount(ctx, params.id);
            if (account?.domain !== null) throw new NotFound();

            return { status: 200, body: (await rolesOf(ctx, account.id)).map(renderVersiaRole) };
        },
    }),
];
