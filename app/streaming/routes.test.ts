import { assertEquals } from "@std/assert";
import { grantRoleTo } from "../accounts/roles.ts";
import { createLocalAccount, createRole } from "../accounts/testing.ts";
import { registerTestApp, tokenFor } from "../auth/testing.ts";
import { issueToken, revokeToken } from "../auth/tokens.ts";
import { StreamingLimits } from "../kernel/config_sections.ts";
import type { PubSub } from "../kernel/context.ts";
import { memoryPubSub } from "../kernel/pubsub.ts";
import { postNote } from "../notes/notes.ts";
import { markerRoutes } from "../markers/routes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { streamingRoutes } from "./routes.ts";

/** What a WebSocket request sends besides its token, as browsers send it. */
const handshake = {
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
};

/** Messages in this process, counting the subscriptions and `onMissed` handlers not yet removed. */
const countedPubSub = () => {
    const pubsub = memoryPubSub();
    const live = new Set<object>();

    const counted = <A extends unknown[]>(watch: (...args: A) => () => void) => (...args: A) => {
        const watched = {};
        live.add(watched);
        const stop = watch(...args);

        return () => {
            live.delete(watched);
            stop();
        };
    };

    const counting: PubSub = {
        send: pubsub.send,
        subscribe: counted(pubsub.subscribe),
        onMissed: counted(pubsub.onMissed),
    };
    return Object.assign(counting, { live: () => live.size });
};

const open = async (
    permissions?: { anonymous: []; default: [] },
    limits = StreamingLimits.parse({}),
) => {
    const pubsub = countedPubSub();
    const test = await createTestContext({ pubsub });
    await createLocalAccount(test.ctx, "alice");
    const app = createTestApp(test.ctx, [...streamingRoutes(limits), ...markerRoutes], {
        checkResponses: true,
        permissions,
    });

    return { ...test, app, pubsub, token: await tokenFor(test.ctx, "alice") };
};

/** Serves `app` on a port of its own, until disposed. */
const listen = (app: { fetch: (request: Request) => Response | Promise<Response> }) => {
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, app.fetch);
    return Object.assign(server, { [Symbol.asyncDispose]: () => server.shutdown() });
};

/** Resolves with the subprotocol the server accepted once `socket` opens, then closes it. */
const accepted = (socket: WebSocket) =>
    new Promise<string>((resolve, reject) => {
        socket.onopen = () => {
            resolve(socket.protocol);
            socket.close();
        };
        socket.onerror = () => reject(new Error("Not opened"));
    });

Deno.test("a WebSocket opens with a user's token, sent in a header, as the protocol or in the query", async () => {
    await using test = await open();
    await using server = listen(test.app);
    const url = `ws://127.0.0.1:${server.addr.port}/api/v1/streaming`;

    assertEquals(
        await accepted(new WebSocket(url, { headers: { authorization: `Bearer ${test.token}` } })),
        "",
    );
    // As browsers send it, which accept it only if the server accepts that protocol.
    assertEquals(await accepted(new WebSocket(url, [test.token])), test.token);
    assertEquals(await accepted(new WebSocket(url, [test.token, "other"])), test.token);
    assertEquals(await accepted(new WebSocket(`${url}?access_token=${test.token}`)), "");
    // The first, of protocols offered by a client sending its token in the header.
    assertEquals(
        await accepted(
            new WebSocket(url, {
                headers: { authorization: `Bearer ${test.token}` },
                protocols: ["one", "two"],
            }),
        ),
        "one",
    );
});

Deno.test("a WebSocket needs a user's valid token, before it opens", async () => {
    await using test = await open();
    const status = async (query: string, headers: Record<string, string> = {}) =>
        (await test.app.request(`/api/v1/streaming${query}`, {
            headers: { ...handshake, ...headers },
        })).status;

    assertEquals(await status(""), 401);
    assertEquals(await status("?access_token=wrong"), 401);
    assertEquals(await status("", { "sec-websocket-protocol": "wrong" }), 401);
    // An app's own token, which is for no user.
    assertEquals(await status(`?access_token=${await tokenFor(test.ctx, null)}`), 422);
});

Deno.test("a request that isn't for a WebSocket finds nothing, and the server is healthy", async () => {
    await using test = await open();
    const streaming = await test.app.request("/api/v1/streaming", {
        headers: { authorization: `Bearer ${test.token}` },
    });
    const health = await test.app.request("/api/v1/streaming/health");

    assertEquals(streaming.status, 404);
    assertEquals([health.status, await health.text()], [200, "OK"]);
});

Deno.test("tokens are only taken from the query or the protocol for streaming", async () => {
    await using test = await open();
    const markers = (init: RequestInit = {}, query = "") =>
        test.app.request(`/api/v1/markers${query}`, init);

    assertEquals((await markers({}, `?access_token=${test.token}`)).status, 401);
    assertEquals(
        (await markers({ headers: { "sec-websocket-protocol": test.token } })).status,
        401,
    );
});

Deno.test("a WebSocket's messages reach its session, from the stream asked for on connecting", async () => {
    await using test = await open();
    await using server = listen(test.app);
    const socket = new WebSocket(
        `ws://127.0.0.1:${server.addr.port}/api/v1/streaming?stream=nope`,
        [test.token],
    );

    const heard: unknown[] = [];
    const closed = new Promise<number>((resolve) => socket.onclose = ({ code }) => resolve(code));
    // Failing rather than waiting forever if no message comes.
    const message = () =>
        new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("No message")), 5_000);
            socket.onmessage = ({ data }) => {
                clearTimeout(timeout);
                resolve(void heard.push(JSON.parse(data)));
            };
        });

    await message();
    const next = message();
    socket.send(JSON.stringify({ type: "unsubscribe", stream: "nope" }));
    await next;
    socket.send(new Uint8Array([1]));

    assertEquals(heard, [
        { error: "Unknown stream type", status: 400 },
        { error: "Error unsubscribing from channel" },
    ]);
    assertEquals(await closed, 1003);
});

/** Resolves as `promise` does, but fails after 5 seconds rather than waiting forever. */
const soon = <T>(promise: Promise<T>) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Too late")), 5_000);
    });

    return Promise.race([promise, late]).finally(() => clearTimeout(timeout));
};

/** Opens a WebSocket with `token`, resolving once its session answers, and with how it closes. */
const connect = async (url: string, token: string) => {
    const socket = new WebSocket(`${url}?stream=nope`, [token]);
    const closing = new Promise<[number, string]>((resolve) =>
        socket.onclose = ({ code, reason }) => resolve([code, reason])
    );

    await soon(new Promise((resolve) => socket.onmessage = resolve));
    return { socket, closed: () => soon(closing) };
};

/** Resolves once `done` is true, checking every few milliseconds, or fails after 5 seconds. */
const until = async (done: () => boolean) => {
    for (const started = Date.now(); !done(); await new Promise((r) => setTimeout(r, 5))) {
        if (Date.now() - started > 5_000) throw new Error("Never done");
    }
};

Deno.test("a WebSocket closes once its token is revoked, and stops watching it once closed", async () => {
    await using test = await open();
    await using server = listen(test.app);
    const url = `ws://127.0.0.1:${server.addr.port}/api/v1/streaming`;
    const { app } = await registerTestApp(test.ctx);
    const issued = await issueToken(test.ctx, app, "alice", ["read"]);
    const before = test.pubsub.live();

    const kept = await connect(url, test.token);
    const revoked = await connect(url, issued.token);
    // Watching each token and its user's roles, and the process hearing statuses, notifications,
    // filter changes, conversations and merged requests, once for every WebSocket, which it does
    // until it stops.
    assertEquals(test.pubsub.live(), before + 5 + 8);

    await revokeToken(test.ctx, app, issued.token);
    assertEquals(await revoked.closed(), [1000, "The access token was revoked"]);
    await until(() => test.pubsub.live() === before + 5 + 4);

    kept.socket.close();
    await kept.closed();
    await until(() => test.pubsub.live() === before + 5);
});

Deno.test("a WebSocket streams what its user may read once their roles change, without reconnecting", async () => {
    await using test = await open({ anonymous: [], default: [] });
    await using server = listen(test.app);
    const socket = new WebSocket(
        `ws://127.0.0.1:${server.addr.port}/api/v1/streaming?stream=public`,
        [test.token],
    );
    const heard: { payload?: string }[] = [];
    socket.onmessage = ({ data }) => void heard.push(JSON.parse(data));
    // Once the session is subscribed, which a message it answers shows.
    await soon(new Promise((resolve) => socket.onopen = resolve));
    socket.send(JSON.stringify({ type: "subscribe", stream: "nope" }));
    await until(() => heard.length === 1);
    const post = async () =>
        (await postNote(test.ctx, "alice", { text: "Hi", format: "text/plain", spoilerText: "" }))
            ?.id;

    // Once its permissions were looked up, without read:note.
    await post();
    await createRole(test.ctx, "Reader", ["read:note"]);
    await grantRoleTo(test.ctx, "alice", "Reader");
    const shown = await post();
    await until(() => heard.length === 2);

    assertEquals(JSON.parse(heard[1].payload ?? "").id, shown);
    socket.close();
});

Deno.test("an account may have only so many WebSockets open, counting those it closed no more", async () => {
    await using test = await open(
        undefined,
        StreamingLimits.parse({ sockets_per_account: 2, subscriptions: 1 }),
    );
    await using server = listen(test.app);
    const url = `ws://127.0.0.1:${server.addr.port}/api/v1/streaming`;
    const refused = () =>
        test.app.request("/api/v1/streaming", {
            headers: { ...handshake, authorization: `Bearer ${test.token}` },
        });

    const first = await connect(url, test.token);
    const second = await connect(url, test.token);
    // With only so many streams each, as configured.
    const answered = new Promise((resolve) => first.socket.onmessage = ({ data }) => resolve(data));
    first.socket.send(JSON.stringify({ type: "subscribe", stream: "public" }));
    first.socket.send(JSON.stringify({ type: "subscribe", stream: "user" }));
    assertEquals(JSON.parse(String(await soon(answered))), {
        error: "Too many subscriptions",
        status: 400,
    });
    const response = await refused();
    assertEquals([response.status, (await response.json()).error], [
        429,
        "Too many WebSockets are open",
    ]);
    // Another user's.
    await createLocalAccount(test.ctx, "bob");
    const bobs = await connect(url, await tokenFor(test.ctx, "bob"));

    first.socket.close();
    await first.closed();
    const third = await connect(url, test.token);

    for (const { socket, closed } of [second, third, bobs]) {
        socket.close();
        await closed();
    }
});

Deno.test("WebSockets opened at once past an account's limit are closed once open", async () => {
    await using test = await open(undefined, StreamingLimits.parse({ sockets_per_account: 1 }));
    await using server = listen(test.app);
    const url = `ws://127.0.0.1:${server.addr.port}/api/v1/streaming`;

    /** How the socket ends up: open, closed with its code, or refused before it opened. */
    const outcome = (socket: WebSocket) =>
        soon(
            new Promise<string>((resolve) => {
                socket.onmessage = () => resolve("open");
                socket.onclose = ({ code }) => resolve(String(code));
                socket.onopen = () => socket.send(JSON.stringify({ type: "subscribe" }));
            }),
        );
    const sockets = [0, 1, 2, 3, 4].map(() => new WebSocket(url, [test.token]));
    const outcomes = await Promise.all(sockets.map(outcome));

    // The others closed once open, or were refused before they opened, by how they raced.
    assertEquals(outcomes.filter((ended) => ended === "open").length, 1);
    const closing = sockets.filter((socket) => socket.readyState !== WebSocket.CLOSED);
    for (const socket of closing) socket.close();
    await soon(
        Promise.all(closing.map((socket) => new Promise((resolve) => socket.onclose = resolve))),
    );
    // Counting none of them once closed.
    const again = await connect(url, test.token);
    again.socket.close();
    await again.closed();
});

Deno.test("WebSockets close, and stop watching their tokens, once Verso stops", async () => {
    await using test = await open();
    const server = listen(test.app);
    const before = test.pubsub.live();
    const { closed } = await connect(
        `ws://127.0.0.1:${server.addr.port}/api/v1/streaming`,
        test.token,
    );

    await server.shutdown();
    await closed();
    // Only the process still hears statuses, notifications, filter changes, conversations and
    // merged requests, until it stops.
    assertEquals(test.pubsub.live(), before + 5);
});

Deno.test("a WebSocket on the user stream is sent the user's statuses, in Mastodon's format", async () => {
    await using test = await open();
    await using server = listen(test.app);
    const socket = new WebSocket(
        `ws://127.0.0.1:${server.addr.port}/api/v1/streaming?stream=user`,
        [test.token],
    );
    const heard: string[] = [];
    socket.onmessage = ({ data }) => void heard.push(data);

    // Once the session is subscribed, which a message it answers shows.
    await soon(new Promise((resolve) => socket.onopen = resolve));
    socket.send(JSON.stringify({ type: "subscribe", stream: "nope" }));
    await until(() => heard.length === 1);

    const note = await postNote(test.ctx, "alice", {
        text: "Hi",
        format: "text/plain",
        spoilerText: "",
    });
    await until(() => heard.length === 2);

    const { stream, event, payload } = JSON.parse(heard[1]);
    assertEquals([stream, event, JSON.parse(payload).id], [["user"], "update", note?.id]);
    socket.close();
});

Deno.test("a WebSocket connecting to a hashtag's stream is sent the statuses using it", async () => {
    await using test = await open();
    await using server = listen(test.app);
    const socket = new WebSocket(
        `ws://127.0.0.1:${server.addr.port}/api/v1/streaming?stream=hashtag&tag=Nix`,
        [test.token],
    );
    const heard: string[] = [];
    socket.onmessage = ({ data }) => void heard.push(data);

    await soon(new Promise((resolve) => socket.onopen = resolve));
    socket.send(JSON.stringify({ type: "subscribe", stream: "nope" }));
    await until(() => heard.length === 1);

    const note = await postNote(test.ctx, "alice", {
        text: "Hi #nix",
        format: "text/plain",
        spoilerText: "",
    });
    await until(() => heard.length === 2);

    const { stream, event, payload } = JSON.parse(heard[1]);
    assertEquals([stream, event, JSON.parse(payload).id], [["hashtag", "Nix"], "update", note?.id]);
    socket.close();
});
