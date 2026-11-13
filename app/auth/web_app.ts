import type { Context } from "../kernel/context.ts";
import { scopes } from "../kernel/scopes.ts";
import type { UrlBuilder } from "../kernel/urls.ts";
import { findAppByClientId, insertApp, updateApp } from "./app_queries.ts";

/** The client id of Verso's own web app, the same on every instance. */
export const webClientId = "verso-web";

/** What `ensureWebApp` did. */
export type WebAppChange = "added" | "updated" | "unchanged";

/**
 * Registers Verso's own web app, or brings it up to date. It is a public client with every scope,
 * which sends users back only to this instance's `/oauth/web-callback`. Users aren't asked to
 * allow it, because Mastodon's own web app is trusted the same way.
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/config/initializers/doorkeeper.rb
 */
export const ensureWebApp = async (
    ctx: Pick<Context, "db" | "clock" | "ids">,
    urls: UrlBuilder,
): Promise<WebAppChange> => {
    const wanted = {
        name: "Verso Web",
        website: urls.url`/`,
        redirect_uris: [urls.url`/oauth/web-callback`],
        scopes: [...scopes],
        client_secret_hash: null,
    };

    const app = await findAppByClientId(ctx, webClientId);

    if (!app) {
        await insertApp(ctx, {
            ...wanted,
            id: ctx.ids(),
            client_id: webClientId,
            created_at: ctx.clock.now(),
        });

        return "added";
    }

    const current = {
        name: app.name,
        website: app.website,
        redirect_uris: app.redirect_uris,
        scopes: app.scopes,
        client_secret_hash: app.client_secret_hash,
    };
    if (JSON.stringify(current) === JSON.stringify(wanted)) return "unchanged";

    await updateApp(ctx, app.id, wanted);
    return "updated";
};
