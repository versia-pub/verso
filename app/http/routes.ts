import { roleRoutes } from "../accounts/role_routes.ts";
import { accountRoutes } from "../accounts/routes.ts";
import { userEntityRoutes } from "../accounts/versia.ts";
import { webfingerRoutes } from "../accounts/webfinger.ts";
import { authRoutes } from "../auth/routes.ts";
import { type AboutSettings, instanceRoutes } from "../instances/routes.ts";
import { versiaInstanceRoutes } from "../instances/versia_routes.ts";
import { openApiRoute } from "./openapi.ts";
import type { Route } from "./route.ts";

/**
 * Every module's routes, with what they accept held to the configured limits, the instance
 * described as configured, and the OpenAPI document describing them all.
 */
export const routes = (settings: AboutSettings): readonly Route[] => {
    const documented = [
        ...authRoutes,
        ...accountRoutes(settings.limits),
        ...roleRoutes,
        ...webfingerRoutes,
        ...userEntityRoutes,
        ...instanceRoutes(settings),
        ...versiaInstanceRoutes(settings.instance),
    ];

    return [...documented, openApiRoute(documented, settings.instance.name)];
};
