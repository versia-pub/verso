import { roleRoutes } from "../accounts/role_routes.ts";
import { directoryRoutes } from "../accounts/directory.ts";
import { accountRoutes } from "../accounts/routes.ts";
import { webfingerRoutes } from "../accounts/webfinger.ts";
import { authRoutes } from "../auth/routes.ts";
import { conversationRoutes } from "../conversations/routes.ts";
import { emojiRoutes } from "../emojis/routes.ts";
import { inboxRoute } from "../federation/inbox.ts";
import { messagingRoute } from "../federation/messaging.ts";
import { filterRoutes } from "../filters/routes.ts";
import { interactionRoutes } from "../interactions/routes.ts";
import { listRoutes } from "../lists/routes.ts";
import { markerRoutes } from "../markers/routes.ts";
import { mediaProxyRoutes } from "../media/proxy.ts";
import { mediaRoutes } from "../media/routes.ts";
import { entityRoutes } from "../federation/registry.ts";
import { graphRoutes } from "../graph/routes.ts";
import { noteRoutes } from "../notes/routes.ts";
import { pollRoutes } from "../polls/routes.ts";
import { reportRoutes } from "../reports/routes.ts";
import { announcementRoutes } from "../announcements/routes.ts";
import { scheduledRoutes } from "../schedules/routes.ts";
import { groupedNotificationRoutes } from "../notifications/grouped_routes.ts";
import { notificationPolicyRoutes } from "../notifications/policy_routes.ts";
import { notificationRequestRoutes } from "../notifications/request_routes.ts";
import { notificationRoutes } from "../notifications/routes.ts";
import { pushRoutes } from "../push/routes.ts";
import { timelineRoutes } from "../notes/timeline_routes.ts";
import type { AboutSettings } from "../instances/render.ts";
import { instanceRoutes } from "../instances/routes.ts";
import { nodeInfoRoutes } from "../instances/nodeinfo.ts";
import { versiaInstanceRoutes } from "../instances/versia_routes.ts";
import { moderationRoutes } from "../moderation/routes.ts";
import { registry } from "../registry.ts";
import { suggestionRoutes } from "../suggestions/routes.ts";
import { trendRoutes } from "../trends/routes.ts";
import { searchRoutes } from "../search/routes.ts";
import { streamingRoutes } from "../streaming/routes.ts";
import { tagRoutes } from "../tags/routes.ts";
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
        ...tagRoutes,
        ...listRoutes,
        ...filterRoutes,
        ...searchRoutes(settings.search),
        ...accountRoutes(settings.media, settings.limits),
        ...directoryRoutes,
        ...noteRoutes(settings.limits),
        ...pollRoutes,
        ...scheduledRoutes,
        ...reportRoutes(settings.instance),
        ...announcementRoutes,
        ...interactionRoutes,
        ...timelineRoutes(settings.timelines_access),
        ...trendRoutes(settings.instance, settings.timelines_access),
        ...suggestionRoutes(settings.instance),
        ...conversationRoutes,
        // Before `/api/v1/notifications/:id`, which would take their paths.
        ...notificationRequestRoutes,
        ...notificationRoutes,
        // Before `/api/v2/notifications/:group_key`, which would take its path.
        ...notificationPolicyRoutes,
        ...groupedNotificationRoutes,
        ...pushRoutes,
        ...markerRoutes,
        ...streamingRoutes(settings.streaming, settings.timelines_access),
        ...mediaRoutes(settings.media, settings.limits),
        ...mediaProxyRoutes,
        ...emojiRoutes(settings.media, settings.limits),
        ...roleRoutes,
        ...webfingerRoutes,
        ...entityRoutes(registry),
        inboxRoute(registry),
        messagingRoute,
        ...instanceRoutes(settings),
        ...moderationRoutes(settings.instance, settings.federation.blocked_domains),
        ...versiaInstanceRoutes(settings.instance, registry.extensions),
        ...nodeInfoRoutes(settings.instance),
        docsRoute,
    ];

    return [...documented, openApiRoute(documented, settings.instance.name)];
};
