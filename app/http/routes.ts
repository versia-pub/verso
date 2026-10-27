import { roleRoutes } from "../accounts/role_routes.ts";
import { accountRoutes } from "../accounts/routes.ts";
import { webfingerRoutes } from "../accounts/webfinger.ts";
import { authRoutes } from "../auth/routes.ts";
import { emojiRoutes } from "../emojis/routes.ts";
import { inboxRoute } from "../federation/inbox.ts";
import { messagingRoute } from "../federation/messaging.ts";
import { interactionRoutes } from "../interactions/routes.ts";
import { markerRoutes } from "../markers/routes.ts";
import { mediaRoutes } from "../media/routes.ts";
import { entityRoutes } from "../federation/registry.ts";
import { graphRoutes } from "../graph/routes.ts";
import { noteRoutes } from "../notes/routes.ts";
import { notificationRoutes } from "../notifications/routes.ts";
import { timelineRoutes } from "../notes/timeline_routes.ts";
import type { AboutSettings } from "../instances/render.ts";
import { instanceRoutes } from "../instances/routes.ts";
import { versiaInstanceRoutes } from "../instances/versia_routes.ts";
import { registry } from "../registry.ts";
import { docsRoute } from "./docs.ts";
import { openApiRoute } from "./openapi.ts";
import type { Route } from "./route.ts";

/**
 * Every module's routes, with what they accept limited by the configured limits, the instance
 * described as configured, and the API documentation, with the OpenAPI document describing them
 * all.
 */
export const routes = (settings: AboutSettings): readonly Route[] => {
    const documented = [
        ...authRoutes,
        // Before the account routes, whose `/api/v1/accounts/:id` would otherwise match their
        // paths.
        ...graphRoutes,
        ...accountRoutes(settings.media, settings.limits),
        ...noteRoutes(settings.limits),
        ...interactionRoutes,
        ...timelineRoutes,
        ...notificationRoutes,
        ...markerRoutes,
        ...mediaRoutes(settings.media, settings.limits),
        ...emojiRoutes(settings.media, settings.limits),
        ...roleRoutes,
        ...webfingerRoutes,
        ...entityRoutes(registry),
        inboxRoute(registry),
        messagingRoute,
        ...instanceRoutes(settings),
        ...versiaInstanceRoutes(settings.instance, registry.extensions),
        docsRoute,
    ];

    return [...documented, openApiRoute(documented, settings.instance.name)];
};
