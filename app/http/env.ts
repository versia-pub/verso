/**
 * What the HTTP app carries for each request, and what it needs from the rest of Verso.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import type { Permission } from "../kernel/permissions.ts";
import type { Viewer } from "./route.ts";

/** What Hono carries for each request. */
export type AppEnv = {
    /** From `Deno.serve`. Tests that call the app directly may omit it. */
    Bindings: { readonly remoteAddr?: { readonly hostname: string } } | undefined;
    Variables: { bearer?: Promise<Viewer | undefined> };
};

/**
 * What the app needs from the rest of Verso, which `main.ts` wires up, so the HTTP layer doesn't
 * depend on the modules that serve it.
 */
export type AppServices = {
    /** The viewer an access token stands for, if this server issued it and it is still valid. */
    readonly authenticate: (ctx: Context, token: string) => Promise<Viewer | undefined>;
    /** What an account may do: what config lets every user, and what its roles allow. */
    readonly permissionsOf: (
        ctx: Context,
        accountId: string,
        everyUser: readonly Permission[],
    ) => Promise<ReadonlySet<Permission>>;
};
