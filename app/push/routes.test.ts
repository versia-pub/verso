import { assertEquals, assertNotEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { registerTestApp } from "../auth/testing.ts";
import { issueToken, revokeToken } from "../auth/tokens.ts";
import type { Scope } from "../kernel/scopes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { vapidPublicKey } from "./keys.ts";
import { pushRoutes } from "./routes.ts";
import { findSubscription } from "./subscription_queries.ts";

const path = "/api/v1/push/subscription";

const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, pushRoutes, { checkResponses: true });
    await createLocalAccount(test.ctx, "alice");
    const { app: client } = await registerTestApp(test.ctx);

    /** A token for alice, and its id. */
    const token = async (scopes: Scope[] = ["push"]) => {
        const issued = await issueToken(test.ctx, client, "alice", scopes);
        return { token: issued.token, id: issued.id };
    };

    const request = async (
        method: string,
        token: string,
        options: { body?: unknown; form?: string } = {},
    ) => {
        const response = await app.request(path, {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                ...(options.body !== undefined && { "content-type": "application/json" }),
                ...(options.form !== undefined &&
                    { "content-type": "application/x-www-form-urlencoded" }),
            },
            body: options.form ??
                (options.body === undefined ? undefined : JSON.stringify(options.body)),
        });

        return { status: response.status, body: await response.json() };
    };

    return { ...test, client, token, request };
};

/** A browser's keys for a subscription, in URL-safe base64. */
const browserKeys = async () => {
    const pair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
    );
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

    return {
        p256dh: raw.toBase64({ alphabet: "base64url", omitPadding: true }),
        auth: crypto.getRandomValues(new Uint8Array(16))
            .toBase64({ alphabet: "base64url", omitPadding: true }),
    };
};

const none = {
    mention: false,
    status: false,
    reblog: false,
    follow: false,
    follow_request: false,
    favourite: false,
    poll: false,
    update: false,
    "admin.sign_up": false,
    "admin.report": false,
    reaction: false,
};

Deno.test("a token subscribes to the notifications it asks for, and keeps itself to push them with", async () => {
    await using test = await open();
    const { token, id } = await test.token();
    const keys = await browserKeys();

    const form = new URLSearchParams({
        "subscription[endpoint]": "https://push.example/a",
        "subscription[keys][p256dh]": keys.p256dh,
        "subscription[keys][auth]": keys.auth,
        "data[alerts][mention]": "true",
        "data[alerts][reaction]": "1",
        "data[alerts][follow]": "false",
        "data[alerts][nope]": "true",
        "data[policy]": "followed",
    });
    const subscribed = await test.request("POST", token, { form: form.toString() });

    assertEquals(subscribed.status, 200);
    const subscription = {
        id: subscribed.body.id,
        endpoint: "https://push.example/a",
        alerts: { ...none, mention: true, reaction: true },
        server_key: await vapidPublicKey(test.ctx),
        policy: "followed",
    };
    assertEquals(subscribed.body, subscription);
    assertEquals(await test.request("GET", token), { status: 200, body: subscription });

    const row = await findSubscription(test.ctx, id);
    assertEquals(
        [row?.account_id, row?.access_token, row?.p256dh, row?.auth],
        ["alice", token, keys.p256dh, keys.auth],
    );
});

Deno.test("subscribing again replaces the token's subscription, but not other tokens'", async () => {
    await using test = await open();
    const first = await test.token();
    const other = await test.token();
    const keys = await browserKeys();
    const subscribe = (token: string, endpoint: string) =>
        test.request("POST", token, { body: { subscription: { endpoint, keys } } });

    const old = await subscribe(first.token, "https://push.example/a");
    await subscribe(other.token, "https://push.example/b");
    const replaced = await subscribe(first.token, "https://push.example/c");

    assertNotEquals(replaced.body.id, old.body.id);
    assertEquals([replaced.body.alerts, replaced.body.policy], [none, "all"]);
    assertEquals((await test.request("GET", first.token)).body.endpoint, "https://push.example/c");
    assertEquals((await test.request("GET", other.token)).body.endpoint, "https://push.example/b");
});

Deno.test("a subscription's notifications are changed, and what isn't given is reset", async () => {
    await using test = await open();
    const { token } = await test.token();
    const other = await test.token();
    const update = (data: unknown) => test.request("PUT", token, { body: { data } });
    assertEquals((await update({})).status, 404);

    for (const subscriber of [token, other.token]) {
        await test.request("POST", subscriber, {
            body: {
                subscription: { endpoint: "https://push.example/a", keys: await browserKeys() },
                data: { alerts: { mention: true }, policy: "none" },
            },
        });
    }
    const changed = await update({ alerts: { favourite: true, reblog: true } });

    assertEquals(changed.status, 200);
    assertEquals(
        [changed.body.alerts, changed.body.policy],
        [{ ...none, favourite: true, reblog: true }, "all"],
    );
    assertEquals((await test.request("GET", token)).body.alerts, changed.body.alerts);
    assertEquals((await test.request("PUT", token, { body: {} })).body.alerts, none);

    const untouched = (await test.request("GET", other.token)).body;
    assertEquals([untouched.alerts, untouched.policy], [{ ...none, mention: true }, "none"]);
});

Deno.test("a subscription goes when it is removed, or its token is revoked", async () => {
    await using test = await open();
    const removed = await test.token();
    const revoked = await test.token();
    const keys = await browserKeys();
    for (const { token } of [removed, revoked]) {
        await test.request("POST", token, {
            body: { subscription: { endpoint: "https://push.example/a", keys } },
        });
    }

    assertEquals(await test.request("DELETE", removed.token), { status: 200, body: {} });
    assertEquals(await test.request("DELETE", removed.token), { status: 200, body: {} });
    assertEquals((await test.request("GET", removed.token)).status, 404);

    await revokeToken(test.ctx, test.client, revoked.token);
    assertEquals(await findSubscription(test.ctx, revoked.id), undefined);
});

Deno.test("subscriptions are refused without push, or https, or keys of the right sizes", async () => {
    await using test = await open();
    const { token, id } = await test.token();
    const keys = await browserKeys();
    const raw = Uint8Array.fromBase64(keys.p256dh, { alphabet: "base64url" });
    const subscribe = async (endpoint: string, p256dh = keys.p256dh, auth = keys.auth) => {
        const response = await test.request("POST", token, {
            body: { subscription: { endpoint, keys: { p256dh, auth } } },
        });
        return response.status;
    };

    assertEquals(await subscribe("http://push.example/a"), 422);
    assertEquals(await subscribe("https://push.example/a", keys.p256dh.slice(0, -2)), 422);
    // A compressed point.
    assertEquals(
        await subscribe("https://push.example/a", new Uint8Array([2, ...raw.slice(1)]).toBase64()),
        422,
    );
    assertEquals(await subscribe("https://push.example/a", keys.p256dh, `${keys.auth}AA`), 422);
    assertEquals(await subscribe("https://push.example/a", keys.p256dh, "not base64!"), 422);

    // Base64 with padding is taken as URL-safe base64 without.
    assertEquals(await subscribe("https://push.example/a", raw.toBase64()), 200);
    assertEquals((await findSubscription(test.ctx, id))?.p256dh, keys.p256dh);

    const reader = await test.token(["read"]);
    assertEquals((await test.request("GET", reader.token)).status, 403);
});
