import { type App, type AppOptions, type AppServices, createApp } from "../http/app.ts";
import type { Route } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { appServices } from "../services.ts";

export type TestAppOptions = Omit<AppOptions, "services"> & {
    /** Defaults to the real ones, as `main.ts` wires them. */
    readonly services?: Partial<AppServices>;
};

/** The app serving `routes`, with Verso's services unless a test replaces some. */
export const createTestApp = (
    ctx: Context,
    routes: readonly Route[],
    options: TestAppOptions = {},
): App =>
    createApp(ctx, routes, { ...options, services: { ...appServices(), ...options.services } });
