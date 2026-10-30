import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import {
    ApiError,
    Client,
    createPkce,
    Stream,
    type StreamEvent,
    UnexpectedResponse,
} from "./client.ts";
import { account } from "./testing.ts";

/** A client whose requests `answer` answers, and the requests it was sent. */
const fake = (answer: (request: Request) => Response, token?: string) => {
    const sent: Request[] = [];
    const client = new Client("https://social.example", {
        token,
        fetch: (input, init) => {
            const request = new Request(input, init);
            sent.push(request);
            return Promise.resolve(answer(request));
        },
    });

    return { client, sent };
};

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);

Deno.test("each value in a path is escaped, so it can't reach another route", async () => {
    const { client, sent } = fake(() => json(account));

    await client.accounts.get("../../oauth/revoke?x=1#y");

    assertEquals(
        new URL(sent[0].url).pathname,
        "/api/v1/accounts/..%2F..%2Foauth%2Frevoke%3Fx%3D1%23y",
    );
});

Deno.test("requests carry the token, and only to the instance", async () => {
    const { client, sent } = fake(() => json(account), "s3cret");

    await client.accounts.lookup("alice@other.example");

    assertEquals(sent[0].headers.get("authorization"), "Bearer s3cret");
    assertEquals(
        sent[0].url,
        "https://social.example/api/v1/accounts/lookup?acct=alice%40other.example",
    );
});

Deno.test("a failure is an ApiError, with the instance's error and rate limit", async () => {
    const { client } = fake(() =>
        json({ error: "Too many requests" }, {
            status: 429,
            headers: {
                "retry-after": "30",
                "x-ratelimit-limit": "300",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "2026-01-31T00:05:00.000Z",
            },
        })
    );

    const before = Date.now();
    const error = await assertRejects(() => client.accounts.get("1"), ApiError);

    assertEquals(error.status, 429);
    assertEquals(error.error, "Too many requests");
    assertEquals(error.rateLimit, {
        limit: 300,
        remaining: 0,
        reset: new Date("2026-01-31T00:05:00.000Z"),
    });
    assertEquals(Math.round(((error.retryAfter?.getTime() ?? 0) - before) / 1000), 30);
    assertEquals(client.rateLimit, error.rateLimit);
});

Deno.test("a request that doesn't validate gives the problems with each field", async () => {
    const { client } = fake(() =>
        json({
            error: "Validation failed",
            error_description: "body.status: Required",
            details: { "body.status": ["Required"] },
        }, { status: 422 })
    );

    const error = await assertRejects(() => client.statuses.post({}), ApiError);

    assertEquals(error.description, "body.status: Required");
    assertEquals(error.details, { "body.status": ["Required"] });
});

Deno.test("a failure without a JSON body is named by its status", async () => {
    const { client } = fake(() => new Response("<html>Bad gateway</html>", { status: 502 }));

    const error = await assertRejects(() => client.instance.get(), ApiError);

    assertEquals([error.status, error.description], [502, undefined]);
});

Deno.test("a success that isn't what the method gives is refused", async () => {
    const { client } = fake(() => json({ id: "1" }));

    const error = await assertRejects(() => client.accounts.get("1"), UnexpectedResponse);

    assertEquals(error.status, 200);
});

Deno.test("pages follow the instance's Link header, and arrays are sent Rails-style", async () => {
    const pages: Record<string, Response> = {
        "1": json([], {
            headers: {
                link: '<https://social.example/api/v1/accounts/1/statuses?max_id=b>; rel="next", ' +
                    '<https://social.example/api/v1/accounts/1/statuses?min_id=c>; rel="prev"',
            },
        }),
        b: json([]),
    };
    const { client, sent } = fake((request) =>
        pages[new URL(request.url).searchParams.get("max_id") ?? "1"]
    );

    const first = await client.accounts.statuses("1", { limit: 2, pinned: true });
    assertEquals([first.hasNext, first.hasPrevious], [true, true]);

    const second = await first.next();
    assertEquals([second?.hasNext, await second?.next()], [false, undefined]);
    assertEquals(sent.map((request) => new URL(request.url).search), [
        "?limit=2&pinned=true",
        "?max_id=b",
    ]);
});

Deno.test("a page never sends the token to a link on another host", async () => {
    const { client, sent } = fake(
        () => json([], { headers: { link: '<https://evil.example/steal>; rel="next"' } }),
        "s3cret",
    );

    const page = await client.accounts.statuses("1");

    await assertRejects(() => page.next(), Error, "isn't on https://social.example");
    assertEquals(sent.length, 1);
});

Deno.test("uploads are sent as forms, without the fields left out", async () => {
    const { client, sent } = fake(() => json({}, { status: 500 }));
    const file = new File([new Uint8Array([1, 2, 3])], "red.png", { type: "image/png" });

    await assertRejects(() => client.media.upload({ file, description: undefined, focus: "0,0" }));

    const form = await sent[0].formData();
    assertEquals([...form.keys()], ["file", "focus"]);
    assertInstanceOf(form.get("file"), File);
});

Deno.test("the authorize URL asks for a code, with a PKCE challenge of the verifier", async () => {
    const { client } = fake(() => json({}));
    const pkce = await createPkce();

    const url = client.oauth.authorizationUrl({
        client_id: "app",
        redirect_uri: "https://app.example/back",
        scopes: ["read", "write:statuses"],
        state: "xyz",
        code_challenge: pkce.challenge,
    });

    assertEquals(url.origin + url.pathname, "https://social.example/oauth/authorize");
    assertEquals(Object.fromEntries(url.searchParams), {
        response_type: "code",
        client_id: "app",
        redirect_uri: "https://app.example/back",
        scope: "read write:statuses",
        state: "xyz",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
    });

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pkce.verifier));
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    assertEquals(
        pkce.challenge,
        base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=$/, ""),
    );
    assertEquals(pkce.verifier.length, 43);
});

Deno.test("forms name nested fields as Rails does, and leave out those not given", async () => {
    const { client, sent } = fake(() => json({}, { status: 500 }));
    const avatar = new File([new Uint8Array([1])], "me.png", { type: "image/png" });

    await assertRejects(() =>
        client.accounts.updateCredentials({
            avatar,
            locked: false,
            fields_attributes: [{ name: "Website", value: "alice.example" }],
            source: { privacy: "unlisted", language: undefined },
        })
    );

    const form = await sent[0].formData();
    assertEquals([...form.keys()], [
        "avatar",
        "locked",
        "fields_attributes[0][name]",
        "fields_attributes[0][value]",
        "source[privacy]",
    ]);
    assertEquals(form.get("locked"), "false");
});

Deno.test("a profile change without pictures is sent as JSON", async () => {
    const { client, sent } = fake(() => json({}, { status: 500 }));

    await assertRejects(() => client.accounts.updateCredentials({ display_name: "Alice" }));

    assertEquals(sent[0].headers.get("content-type"), "application/json");
    assertEquals(await sent[0].json(), { display_name: "Alice" });
});

Deno.test("relationships ask for each id Rails-style", async () => {
    const { client, sent } = fake(() => json([]));

    await client.accounts.relationships(["1", "2"]);

    assertEquals(new URL(sent[0].url).search, "?id%5B%5D=1&id%5B%5D=2");
});

Deno.test("a reaction's emoji is escaped in its path, custom or not", async () => {
    const { client, sent } = fake(() => json([]));

    await client.statuses.reactedBy("1", ":blob@b.example:");
    await client.statuses.reactedBy("1", "👍");

    assertEquals(sent.map((request) => new URL(request.url).pathname), [
        "/api/v1/statuses/1/reactions/%3Ablob%40b.example%3A",
        "/api/v1/statuses/1/reactions/%F0%9F%91%8D",
    ]);
});

Deno.test("a list in a shape of its own gives each page's body, and its items across pages", async () => {
    const page = (groups: string[], next?: string) =>
        json(
            {
                accounts: [],
                statuses: [],
                notification_groups: groups.map((key) => ({
                    group_key: key,
                    notifications_count: 1,
                    type: "follow",
                    most_recent_notification_id: key,
                    sample_account_ids: [],
                })),
            },
            next === undefined ? {} : { headers: { link: `<${next}>; rel="next"` } },
        );
    const { client } = fake((request) =>
        new URL(request.url).searchParams.has("max_id")
            ? page(["1"])
            : page(["3", "2"], "https://social.example/api/v2/notifications?max_id=2")
    );

    const first = await client.groupedNotifications.list();
    const bodies = [];
    for await (const each of first.pages()) bodies.push(each.body.notification_groups.length);
    const keys = [];
    for await (const group of first) keys.push(group.group_key);

    assertEquals(bodies, [2, 1]);
    assertEquals(keys, ["3", "2", "1"]);
});

/** A WebSocket the instance sends `messages` on, then closes. */
const fakeSocket = (messages: readonly string[]) => {
    const socket = Object.assign(new EventTarget(), {
        onmessage: undefined as ((message: MessageEvent) => void) | undefined,
        closedWith: undefined as number | undefined,
        send: () => {},
        close: (code: number) => {
            socket.closedWith = code;
            socket.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
        },
    });
    queueMicrotask(() => {
        for (const data of messages) socket.onmessage?.(new MessageEvent("message", { data }));
    });

    return socket;
};

Deno.test("a stream gives events it doesn't know, and ends at a message that isn't one", async () => {
    const socket = fakeSocket([
        JSON.stringify({ stream: ["user"], event: "filters_changed", payload: "" }),
        JSON.stringify({ stream: ["user"], event: "update", payload: "{}" }),
        JSON.stringify({ stream: ["user"], event: "delete", payload: "1" }),
    ]);
    const stream = new Stream(socket as unknown as WebSocket);

    const events: StreamEvent[] = [];
    const error = await assertRejects(async () => {
        for await (const event of stream) events.push(event);
    }, UnexpectedResponse);

    assertEquals(events, [
        { event: "unknown", stream: ["user"], name: "filters_changed", payload: "" },
    ]);
    assertEquals(error.status, 101);
    assertEquals(socket.closedWith, 1003);
});
