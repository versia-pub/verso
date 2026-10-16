import { roleRoutes } from "../accounts/role_routes.ts";
import { accountRoutes } from "../accounts/routes.ts";
import { authRoutes } from "../auth/routes.ts";
import { type AboutSettings, instanceRoutes } from "../instances/routes.ts";
import type { Route } from "./route.ts";

/**
 * Every module's routes, with what they accept held to the configured limits, and the instance
 * described as configured.
 */
export const routes = (settings: AboutSettings): readonly Route[] => [
    ...authRoutes,
    ...accountRoutes(settings.limits),
    ...roleRoutes,
    ...instanceRoutes(settings),
];
