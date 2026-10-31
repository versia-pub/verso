import { assertEquals } from "@std/assert";
import { Client } from "@versia/client-api";
import openapi from "./openapi.json" with { type: "json" };

/**
 * The client method for each operation of the client API, called as a client would. Each must make
 * the request its operation describes. A new route needs one here, and one in the client.
 */
const calls: Record<string, (client: Client) => unknown> = {
    "POST /api/v1/apps": (c) => c.oauth.registerApp({ client_name: "App", redirect_uris: [] }),
    "GET /api/v1/apps/verify_credentials": (c) => c.oauth.verifyApp(),
    "GET /oauth/authorize": (c) => c.oauth.authorizationUrl({ client_id: "1", redirect_uri: "" }),
    "POST /oauth/token": (c) => c.oauth.appToken(app),
    "POST /oauth/revoke": (c) => c.oauth.revoke(app, "token"),
    "GET /.well-known/oauth-authorization-server": (c) => c.oauth.metadata(),

    "GET /api/v2/instance": (c) => c.instance.get(),
    "GET /api/v1/instance": (c) => c.instance.getV1(),
    "GET /api/v1/instance/rules": (c) => c.instance.rules(),
    "GET /api/v1/instance/extended_description": (c) => c.instance.extendedDescription(),
    "GET /api/v1/instance/privacy_policy": (c) => c.instance.privacyPolicy(),
    "GET /api/v1/instance/terms_of_service": (c) => c.instance.termsOfService(),
    "GET /api/v1/instance/terms_of_service/{date}": (c) => c.instance.termsOfService("2026-01-01"),
    "GET /api/v1/instance/peers": (c) => c.instance.peers(),
    "GET /api/v1/instance/activity": (c) => c.instance.activity(),
    "GET /api/v1/instance/languages": (c) => c.instance.languages(),
    "GET /api/v1/instance/domain_blocks": (c) => c.instance.domainBlocks(),

    "GET /api/v1/accounts/verify_credentials": (c) => c.accounts.verifyCredentials(),
    "PATCH /api/v1/accounts/update_credentials": (c) => c.accounts.updateCredentials({}),
    "GET /api/v1/preferences": (c) => c.accounts.preferences(),
    "DELETE /api/v1/profile/avatar": (c) => c.accounts.deleteAvatar(),
    "DELETE /api/v1/profile/header": (c) => c.accounts.deleteHeader(),
    "GET /api/v1/accounts": (c) => c.accounts.getMany(["1"]),
    "GET /api/v1/accounts/{id}": (c) => c.accounts.get("1"),
    "GET /api/v1/accounts/lookup": (c) => c.accounts.lookup("alice"),
    "GET /api/v1/accounts/search": (c) => c.accounts.search({ q: "alice" }),
    "GET /api/v1/directory": (c) => c.accounts.directory(),
    "GET /api/v1/accounts/{id}/statuses": (c) => c.accounts.statuses("1"),
    "GET /api/v1/accounts/{id}/followers": (c) => c.accounts.followers("1"),
    "GET /api/v1/accounts/{id}/following": (c) => c.accounts.following("1"),
    "GET /api/v1/accounts/relationships": (c) => c.accounts.relationships(["1"]),
    "GET /api/v1/accounts/familiar_followers": (c) => c.accounts.familiarFollowers(["1"]),
    "POST /api/v1/accounts/{id}/follow": (c) => c.accounts.follow("1"),
    "POST /api/v1/accounts/{id}/unfollow": (c) => c.accounts.unfollow("1"),
    "POST /api/v1/accounts/{id}/remove_from_followers": (c) => c.accounts.removeFromFollowers("1"),
    "POST /api/v1/accounts/{id}/block": (c) => c.accounts.block("1"),
    "POST /api/v1/accounts/{id}/unblock": (c) => c.accounts.unblock("1"),
    "POST /api/v1/accounts/{id}/mute": (c) => c.accounts.mute("1"),
    "POST /api/v1/accounts/{id}/unmute": (c) => c.accounts.unmute("1"),
    "POST /api/v1/accounts/{id}/note": (c) => c.accounts.note("1", ""),
    "POST /api/v1/accounts/{id}/pin": (c) => c.accounts.pin("1"),
    "POST /api/v1/accounts/{id}/unpin": (c) => c.accounts.unpin("1"),
    "GET /api/v1/endorsements": (c) => c.endorsements.list(),
    "GET /api/v1/featured_tags": (c) => c.featuredTags.list(),
    "POST /api/v1/featured_tags": (c) => c.featuredTags.feature("cats"),
    "DELETE /api/v1/featured_tags/{id}": (c) => c.featuredTags.unfeature("1"),
    "GET /api/v1/featured_tags/suggestions": (c) => c.featuredTags.suggestions(),
    "GET /api/v1/accounts/{id}/featured_tags": (c) => c.accounts.featuredTags("1"),
    "GET /api/v1/tags/{name}": (c) => c.tags.get("cats"),
    "POST /api/v1/tags/{name}/follow": (c) => c.tags.follow("cats"),
    "POST /api/v1/tags/{name}/unfollow": (c) => c.tags.unfollow("cats"),
    "GET /api/v1/followed_tags": (c) => c.followedTags.list(),
    "GET /api/v1/lists": (c) => c.lists.list(),
    "GET /api/v1/lists/{id}": (c) => c.lists.get("1"),
    "POST /api/v1/lists": (c) => c.lists.create({ title: "Friends" }),
    "PUT /api/v1/lists/{id}": (c) => c.lists.update("1", { title: "Friends" }),
    "DELETE /api/v1/lists/{id}": (c) => c.lists.delete("1"),
    "GET /api/v1/lists/{id}/accounts": (c) => c.lists.accounts("1"),
    "POST /api/v1/lists/{id}/accounts": (c) => c.lists.addAccounts("1", ["1"]),
    "DELETE /api/v1/lists/{id}/accounts": (c) => c.lists.removeAccounts("1", ["1"]),
    "GET /api/v1/accounts/{id}/lists": (c) => c.accounts.lists("1"),

    "GET /api/v1/follow_requests": (c) => c.followRequests.list(),
    "POST /api/v1/follow_requests/{id}/authorize": (c) => c.followRequests.authorize("1"),
    "POST /api/v1/follow_requests/{id}/reject": (c) => c.followRequests.reject("1"),
    "GET /api/v1/blocks": (c) => c.blocks.list(),
    "GET /api/v1/mutes": (c) => c.mutes.list(),
    "GET /api/v1/domain_blocks": (c) => c.domainBlocks.list(),
    "POST /api/v1/domain_blocks": (c) => c.domainBlocks.block("b.example"),
    "DELETE /api/v1/domain_blocks": (c) => c.domainBlocks.unblock("b.example"),

    "POST /api/v1/statuses": (c) => c.statuses.post({ status: "Hi" }),
    "GET /api/v1/statuses": (c) => c.statuses.getMany(["1"]),
    "GET /api/v1/statuses/{id}": (c) => c.statuses.get("1"),
    "PUT /api/v1/statuses/{id}": (c) => c.statuses.edit("1", { status: "Hi" }),
    "DELETE /api/v1/statuses/{id}": (c) => c.statuses.delete("1"),
    "GET /api/v1/statuses/{id}/source": (c) => c.statuses.source("1"),
    "GET /api/v1/statuses/{id}/context": (c) => c.statuses.context("1"),
    "GET /api/v1/statuses/{id}/history": (c) => c.statuses.history("1"),
    "POST /api/v1/statuses/{id}/favourite": (c) => c.statuses.favourite("1"),
    "POST /api/v1/statuses/{id}/unfavourite": (c) => c.statuses.unfavourite("1"),
    "GET /api/v1/statuses/{id}/favourited_by": (c) => c.statuses.favouritedBy("1"),
    "POST /api/v1/statuses/{id}/reblog": (c) => c.statuses.reblog("1"),
    "POST /api/v1/statuses/{id}/unreblog": (c) => c.statuses.unreblog("1"),
    "GET /api/v1/statuses/{id}/reblogged_by": (c) => c.statuses.rebloggedBy("1"),
    "POST /api/v1/statuses/{id}/pin": (c) => c.statuses.pin("1"),
    "POST /api/v1/statuses/{id}/unpin": (c) => c.statuses.unpin("1"),
    "GET /api/v1/statuses/{id}/reactions": (c) => c.statuses.reactions("1"),
    "PUT /api/v1/statuses/{id}/reactions/{name}": (c) => c.statuses.react("1", "👍"),
    "DELETE /api/v1/statuses/{id}/reactions/{name}": (c) => c.statuses.unreact("1", "👍"),
    "GET /api/v1/statuses/{id}/reactions/{name}": (c) => c.statuses.reactedBy("1", "👍"),
    "GET /api/v1/favourites": (c) => c.favourites.list(),
    "POST /api/v1/statuses/{id}/bookmark": (c) => c.statuses.bookmark("1"),
    "POST /api/v1/statuses/{id}/unbookmark": (c) => c.statuses.unbookmark("1"),
    "GET /api/v1/bookmarks": (c) => c.bookmarks.list(),
    "POST /api/v1/statuses/{id}/mute": (c) => c.statuses.mute("1"),
    "POST /api/v1/statuses/{id}/unmute": (c) => c.statuses.unmute("1"),

    "POST /api/v2/media": (c) => c.media.upload({ file: new Blob([]) }),
    "PUT /api/v1/media/{id}": (c) => c.media.update("1", {}),
    "GET /api/v1/media/{id}": (c) => c.media.get("1"),

    "GET /api/v1/timelines/home": (c) => c.timelines.home(),
    "GET /api/v1/timelines/public": (c) => c.timelines.public(),
    "GET /api/v1/timelines/tag/{hashtag}": (c) => c.timelines.tag("cats"),

    "GET /api/v1/notifications": (c) => c.notifications.list(),
    "GET /api/v1/notifications/{id}": (c) => c.notifications.get("1"),
    "GET /api/v1/notifications/unread_count": (c) => c.notifications.unreadCount(),
    "POST /api/v1/notifications/{id}/dismiss": (c) => c.notifications.dismiss("1"),
    "POST /api/v1/notifications/clear": (c) => c.notifications.clear(),
    "GET /api/v2/notifications": (c) => c.groupedNotifications.list(),
    "GET /api/v2/notifications/{group_key}": (c) => c.groupedNotifications.get("1"),
    "GET /api/v2/notifications/{group_key}/accounts": (c) => c.groupedNotifications.accounts("1"),
    "GET /api/v2/notifications/unread_count": (c) => c.groupedNotifications.unreadCount(),
    "POST /api/v2/notifications/{group_key}/dismiss": (c) => c.groupedNotifications.dismiss("1"),
    "POST /api/v2/notifications/clear": (c) => c.groupedNotifications.clear(),
    "GET /api/v1/markers": (c) => c.markers.get(["home"]),
    "POST /api/v1/markers": (c) => c.markers.set({}),

    "GET /api/v1/streaming/health": (c) => c.streaming.health(),
    "POST /api/v1/push/subscription": (c) =>
        c.push.subscribe({ endpoint: "https://push.example", keys: { p256dh: "", auth: "" } }),
    "GET /api/v1/push/subscription": (c) => c.push.get(),
    "PUT /api/v1/push/subscription": (c) => c.push.update({}),
    "DELETE /api/v1/push/subscription": (c) => c.push.unsubscribe(),

    "GET /api/v2/search": (c) => c.search({ q: "cats" }),

    "GET /api/v1/custom_emojis": (c) => c.emojis.list(),
    "POST /api/v1/emojis": (c) => c.emojis.create({ shortcode: "blob", element: new Blob([]) }),
    "GET /api/v1/emojis/{id}": (c) => c.emojis.get("1"),
    "PATCH /api/v1/emojis/{id}": (c) => c.emojis.update("1", {}),
    "DELETE /api/v1/emojis/{id}": (c) => c.emojis.delete("1"),

    "GET /api/v1/roles": (c) => c.roles.list(),
    "POST /api/v1/roles": (c) => c.roles.create({ name: "Mod" }),
    "GET /api/v1/roles/{id}": (c) => c.roles.get("1"),
    "PATCH /api/v1/roles/{id}": (c) => c.roles.update("1", {}),
    "DELETE /api/v1/roles/{id}": (c) => c.roles.delete("1"),
    "GET /api/v1/accounts/{id}/roles": (c) => c.roles.ofAccount("1"),
    "POST /api/v1/accounts/{id}/roles/{role_id}": (c) => c.roles.give("1", "2"),
    "DELETE /api/v1/accounts/{id}/roles/{role_id}": (c) => c.roles.take("1", "2"),
};

/** Operations no client method makes, and why. */
const uncalled: Record<string, string> = {
    "GET /api/v1/streaming":
        "A WebSocket, which `streaming.connect` opens, tested in client.test.ts",
    "POST /oauth/authorize/issuer": "A page the user's browser submits, while logging in",
    "GET /oauth/callback": "Where the issuer sends the user's browser back to",
    "GET /oauth/consent": "A page the user's browser shows",
    "POST /oauth/consent": "A page the user's browser submits",
};

const app = { client_id: "1", client_secret: "2" };

/** Each operation of the client API, as `METHOD /path`, with its parameters in braces. */
const operations = Object.entries(openapi.paths)
    .filter(([path]) => /^\/(api|oauth)\/|^\/\.well-known\/oauth-/.test(path))
    .flatMap(([path, methods]) =>
        Object.keys(methods)
            .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
            .map((method) => `${method.toUpperCase()} ${path}`)
    );

/** Whether `request` is for `operation`, whatever its parameters. */
const isFor = (operation: string, request: Request | URL) => {
    const [method, template] = operation.split(" ");
    const pattern = new RegExp(
        `^${template.replaceAll(".", "\\.").replaceAll(/\{[^}]+\}/g, "[^/]+")}$`,
    );
    const url = request instanceof URL ? request : new URL(request.url);

    return (request instanceof URL ? "GET" : request.method) === method &&
        pattern.test(url.pathname);
};

Deno.test("each operation of the client API has a client method, or a reason it has none", () => {
    assertEquals([...Object.keys(calls), ...Object.keys(uncalled)].sort(), operations.sort());
});

Deno.test("each client method makes the request of its operation", async () => {
    const wrong: string[] = [];

    for (const [operation, call] of Object.entries(calls)) {
        const sent: Request[] = [];
        const client = new Client("https://social.example", {
            token: "token",
            fetch: (input, init) => {
                sent.push(new Request(input, init));
                return Promise.resolve(Response.json({ error: "Nope" }, { status: 500 }));
            },
        });

        const result = await Promise.resolve(call(client)).catch(() => undefined);
        const made = result instanceof URL ? [result] : sent;
        if (made.length !== 1 || !isFor(operation, made[0])) wrong.push(operation);
    }

    assertEquals(wrong, []);
});
