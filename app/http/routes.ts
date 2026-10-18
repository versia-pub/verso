import { roleRoutes } from "../accounts/role_routes.ts";
import { accountRoutes } from "../accounts/routes.ts";
import { webfingerRoutes } from "../accounts/webfinger.ts";
import { authRoutes } from "../auth/routes.ts";
import { entityRoutes } from "../federation/registry.ts";
import type { AboutSettings } from "../instances/render.ts";
import { instanceRoutes } from "../instances/routes.ts";
import { versiaInstanceRoutes } from "../instances/versia_routes.ts";
import { registry } from "../registry.ts";
import { docsRoute } from "./docs.ts";
import { openApiRoute } from "./openapi.ts";
import type { Route } from "./route.ts";

/**
 * Every module's routes, with what they accept held to the configured limits, the instance
 * described as configured, and the API documentation, with the OpenAPI document describing them
 * all.
 */
export const routes = (settings: AboutSettings): readonly Route[] => {
    const documented = [
        ...authRoutes,
        ...accountRoutes(settings.limits),
        ...roleRoutes,
        ...webfingerRoutes,
        ...entityRoutes(registry),
        ...instanceRoutes(settings),
        ...versiaInstanceRoutes(settings.instance, registry.extensions),
        docsRoute,
    ];

    return [...documented, openApiRoute(documented, settings.instance.name)];
};
