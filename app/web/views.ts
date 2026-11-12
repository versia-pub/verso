/**
 * Every page Verso renders itself, by its address.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import type { Permission } from "../kernel/permissions.ts";
import type { View } from "./page.tsx";
import { profileView } from "./profile.tsx";
import { statusView } from "./status.tsx";

/** A page Verso renders itself, for anyone, who is never logged in as far as it knows. */
export type ViewRoute = {
    /** In Hono's syntax, such as `/:acct{@[^/]+}`. */
    readonly path: string;
    /** What anonymous visitors must be allowed to see the view, as in `[permissions] anonymous`. */
    readonly permission: Permission;
    /** The view at the address, with its `params`, or nothing if there is nothing there. */
    readonly render: (
        ctx: Context,
        params: Readonly<Record<string, string>>,
    ) => Promise<View | undefined>;
};

export const views: readonly ViewRoute[] = [
    {
        path: "/:acct{@[^/]+}",
        permission: "read:account",
        render: (ctx, params) => profileView(ctx, params.acct ?? ""),
    },
    {
        path: "/:acct{@[^/]+}/:id",
        permission: "read:note",
        render: (ctx, params) => statusView(ctx, params.acct ?? "", params.id ?? ""),
    },
];
