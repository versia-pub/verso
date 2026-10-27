import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
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

const open = async () => {
    const test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    const app = createTestApp(test.ctx, [...streamingRoutes, ...markerRoutes], {
        checkResponses: true,
    });

    return { ...test, app, token: await tokenFor(test.ctx, "alice") };
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
