import { z } from "zod";
import { PreconditionFailed } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { saveWebPreferences, webPreferencesOf } from "./web_preferences.ts";

/** The settings, which only the web app reads. */
const Settings = z.record(z.string(), z.unknown());

/** The web app's settings for the user, which follow them from browser to browser. */
export const webPreferenceRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/web_preferences",
        summary: "View web app settings",
        description:
            "The settings the web app saved for the user, or an empty object if it saved none. " +
            "The ETag header names this version of them, for If-Match when saving.",
        tags: ["accounts"],
        auth: { require: "user", scope: "read:accounts", whileMoved: true },
        responses: { 200: Settings },
        handler: async (ctx, { viewer }) => {
            const { data, etag } = await webPreferencesOf(ctx, viewer.accountId);

            return { status: 200, body: data, headers: { etag } };
        },
    }),
    defineRoute({
        method: "PUT",
        path: "/api/v1/web_preferences",
        summary: "Save web app settings",
        description:
            "Replaces the user's web app settings with a JSON object. With If-Match, they are " +
            "only replaced if its ETag is still the current one, and 412 is returned if not. " +
            "The ETag header names the new version.",
        tags: ["accounts"],
        auth: {
            require: "user",
            scope: "write:accounts",
            permission: "owner:account",
            whileMoved: true,
        },
        headers: z.object({ "if-match": z.string().optional() }),
        body: Settings,
        responses: { 200: Settings },
        handler: async (ctx, { viewer, headers, body }) => {
            const etag = await saveWebPreferences(ctx, viewer.accountId, body, headers["if-match"]);
            if (etag === undefined) throw new PreconditionFailed();

            return { status: 200, body, headers: { etag } };
        },
    }),
];
