/**
 * Streaming end to end, between complete instances: a remote status that arrives, and its delete,
 * streamed to a local user over a WebSocket, on each stream it belongs to.
 * @module
 */
import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { clientOf, followAddress } from "../testing/clients.ts";
import { createNetwork } from "../testing/network.ts";

/** Resolves once `done` is true, checking every few milliseconds, or fails after 5 seconds. */
const until = async (done: () => boolean) => {
    for (const started = Date.now(); !done(); await new Promise((r) => setTimeout(r, 5))) {
        if (Date.now() - started > 5_000) throw new Error("Never done");
    }
};

Deno.test("a remote status that arrives, and its delete, are streamed on each stream it belongs to", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    const b = network.instances["b.test"];
    const alice = await clientOf(a, await createLocalAccount(a.ctx, "alice"));
    const bob = await clientOf(b, await createLocalAccount(b.ctx, "bob"));
    await followAddress(alice, "bob@b.test");
    await network.drain();

    // Served for real, as a WebSocket needs, though other instances reach it through the network.
    const served = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, a.app.fetch);
    await using server = Object.assign(served, {
        [Symbol.asyncDispose]: () => served.shutdown(),
    });
    const socket = new WebSocket(
        `ws://127.0.0.1:${server.addr.port}/api/v1/streaming?stream=user`,
        [await tokenFor(a.ctx, "alice")],
    );
    const heard: { stream: string[]; event: string; payload: string }[] = [];
    socket.onmessage = ({ data }) => void heard.push(JSON.parse(data));
    await new Promise((resolve) => socket.onopen = resolve);
    for (const stream of ["public:remote", "hashtag:local", "nope"]) {
        socket.send(JSON.stringify({ type: "subscribe", stream, tag: "nix" }));
    }
    socket.send(JSON.stringify({ type: "subscribe", stream: "hashtag", tag: "Nix" }));
    socket.send(JSON.stringify({ type: "subscribe", stream: "nope" }));
    // Once both errors are back, the session has every subscription.
    await until(() => heard.length === 2);
    heard.length = 0;

    const posted = await bob("POST", "/api/v1/statuses", { status: "@alice@a.test Hi #nix" });
    await network.drain();
    await until(() => heard.length === 4);

    /** What was heard, as each event's stream, type, and status's URI or notification's type. */
    const events = () =>
        heard.map(({ stream, event, payload }) => {
            const body = event === "delete" ? payload : JSON.parse(payload);
            return [
                stream.join(),
                event,
                event === "delete" ? body : event === "notification" ? body.type : body.uri,
            ];
        }).toSorted();
    const uri = `https://b.test/.versia/v0.6/entities/Note/${posted.body.id}`;
    // Not on the local hashtag's stream, as it isn't local.
    assertEquals(events(), [
        ["hashtag,Nix", "update", uri],
        ["public:remote", "update", uri],
        ["user", "notification", "mention"],
        ["user", "update", uri],
    ]);

    // Deletes name a.test's id for the status.
    const id = JSON.parse(heard.find(({ event }) => event === "update")?.payload ?? "{}").id;
    heard.length = 0;
    await bob("DELETE", `/api/v1/statuses/${posted.body.id}`);
    await network.drain();
    await until(() => heard.length === 4);
    assertEquals(events(), [
        ["hashtag,Nix", "delete", id],
        ["hashtag:local,nix", "delete", id],
        ["public:remote", "delete", id],
        ["user", "delete", id],
    ]);

    socket.close();
    await new Promise((resolve) => socket.onclose = resolve);
});
