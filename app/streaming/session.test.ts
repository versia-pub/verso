import { assertEquals } from "@std/assert";
import type { Scope } from "../kernel/scopes.ts";
import { openSession } from "./session.ts";

/** A session for a token with `scopes`, on a socket that keeps what it's sent. */
const open = (
    scopes: readonly Scope[],
    query: { readonly stream?: string; readonly tag?: string } = {},
    limits?: { readonly subscriptions: number; readonly tag_length: number },
) => {
    const sent: unknown[] = [];
    const closed: [number, string][] = [];
    const viewer = { tokenId: "token", appId: "app", accountId: "alice", scopes };
    const session = openSession(
        viewer,
        {
            send: (data) => void sent.push(JSON.parse(data)),
            close: (code, reason) => void closed.push([code, reason]),
        },
        query,
        limits,
    );

    const send = (...messages: unknown[]) => {
        for (const message of messages) session.receive(JSON.stringify(message));
    };

    return { session, sent, closed, send };
};

Deno.test("a client subscribes to streams once each, when it connects or later, until it unsubscribes", () => {
    const { session, sent, send } = open(["read"], { stream: "user" });
    assertEquals(session.streams(), ["user"]);

    send(
        { type: "subscribe", stream: "public:local" },
        { type: "subscribe", stream: "user" },
        // The first, as on Mastodon.
        { type: "subscribe", stream: ["user:notification", "public"] },
    );
    assertEquals(session.streams(), ["user", "public:local", "user:notification"]);

    send(
        { type: "unsubscribe", stream: "user" },
        { type: "unsubscribe", stream: ["public:local", "user:notification"] },
        // Not subscribed to.
        { type: "unsubscribe", stream: "public:remote:media" },
    );
    assertEquals(session.streams(), ["user:notification"]);
    assertEquals(sent, []);
});

Deno.test("a client subscribes only to streams its token's scopes allow, and public ones", () => {
    const { session, sent, send } = open(["read:notifications"]);
    const refused = { error: "Access token does not have the required scopes", status: 401 };

    send(
        { type: "subscribe", stream: "user" },
        { type: "subscribe", stream: "user:notification" },
        ...["", ":media", ":local", ":local:media", ":remote", ":remote:media"].map((variant) => ({
            type: "subscribe",
            stream: `public${variant}`,
        })),
    );

    assertEquals(session.streams(), [
        "user:notification",
        "public",
        "public:media",
        "public:local",
        "public:local:media",
        "public:remote",
        "public:remote:media",
    ]);
    assertEquals(sent, [refused]);

    // A user's statuses, though not their notifications.
    const statuses = open(["read:statuses"], { stream: "user:notification" });
    statuses.send({ type: "subscribe", stream: "user" });
    assertEquals([statuses.session.streams(), statuses.sent], [["user"], [refused]]);
});

Deno.test("a client is told of streams that don't exist, once its token could read one", () => {
    const unknown = { error: "Unknown stream type", status: 400 };
    const reading = open(["read:statuses"], { stream: "direct" });
    reading.send({ type: "subscribe" }, { type: "subscribe", stream: [] }, {
        type: "subscribe",
        stream: "constructor",
    });

    const writing = open(["write"], { stream: "nope" });

    assertEquals(reading.sent, [unknown, unknown, unknown, unknown]);
    assertEquals(writing.sent, [{
        error: "Access token does not have the required scopes",
        status: 401,
    }]);
    assertEquals([reading.session.streams(), writing.session.streams()], [[], []]);
});

Deno.test("a client is told it can't unsubscribe from streams that don't exist", () => {
    const { session, sent, send } = open(["read"], { stream: "user" });
    send({ type: "unsubscribe", stream: "nope" }, { type: "unsubscribe" });

    assertEquals(sent, [
        { error: "Error unsubscribing from channel" },
        { error: "Error unsubscribing from channel" },
    ]);
    assertEquals(session.streams(), ["user"]);
});

Deno.test("messages that aren't JSON, or aren't requests, are ignored, and bytes close the socket", () => {
    const { session, sent, closed, send } = open(["read"]);

    session.receive("{");
    send(null, 5, "subscribe", { stream: "user" }, { type: "listen", stream: "user" }, {
        type: "subscribe",
        stream: 5,
    });
    assertEquals([session.streams(), sent, closed], [[], [], []]);

    session.receive(new ArrayBuffer(2));
    assertEquals(closed, [[1003, "Verso's streaming doesn't support binary messages"]]);
});

Deno.test("a client subscribes to hashtags' streams, whatever their case, if it names them", () => {
    // Public streams.
    const { session, sent, send } = open(["read:notifications"], { stream: "hashtag", tag: "Nix" });
    const missing = { error: "Missing tag name parameter", status: 400 };

    send(
        { type: "subscribe", stream: "hashtag", tag: "nix" },
        { type: "subscribe", stream: "hashtag:local", tag: "nix" },
        { type: "subscribe", stream: ["hashtag", "hashtag:local"], tag: "Rust" },
        { type: "subscribe", stream: "hashtag" },
        { type: "subscribe", stream: "hashtag:local", tag: "" },
        // Only hashtags' streams have one.
        { type: "subscribe", stream: "public", tag: "nix" },
    );
    assertEquals(session.streams(), ["hashtag#nix", "hashtag:local#nix", "hashtag#rust", "public"]);
    assertEquals(sent, [missing, missing]);

    // Named as the client first wrote them.
    sent.length = 0;
    session.deliver(["hashtag#nix", "hashtag#rust", "public"], "update", "{}");
    assertEquals(sent.map((event) => (event as { stream: string[] }).stream), [
        ["hashtag", "Nix"],
        ["hashtag", "Rust"],
        ["public"],
    ]);

    sent.length = 0;
    send(
        { type: "unsubscribe", stream: "hashtag", tag: "NIX" },
        // Not subscribed to.
        { type: "unsubscribe", stream: "hashtag", tag: "go" },
        { type: "unsubscribe", stream: "hashtag:local" },
    );
    assertEquals(session.streams(), ["hashtag:local#nix", "hashtag#rust", "public"]);
    assertEquals(sent, [{ error: "Error unsubscribing from channel" }]);
});

Deno.test("a client subscribes to no more streams than the limit, nor hashtags longer than it", () => {
    const { session, sent, send } = open(["read"], { stream: "hashtag", tag: "ab" }, {
        subscriptions: 3,
        tag_length: 3,
    });

    send(
        // Characters, not bytes or UTF-16 code units.
        { type: "subscribe", stream: "hashtag", tag: "é😀a" },
        { type: "subscribe", stream: "hashtag", tag: "abcd" },
        // Which isn't a hashtag's, so its tag counts for nothing.
        { type: "subscribe", stream: "public", tag: "abcd" },
        // Already subscribed to.
        { type: "subscribe", stream: "public" },
        { type: "subscribe", stream: "user" },
    );
    assertEquals(session.streams(), ["hashtag#ab", "hashtag#é😀a", "public"]);
    assertEquals(sent, [
        { error: "Tag name is too long", status: 400 },
        { error: "Too many subscriptions", status: 400 },
    ]);

    send({ type: "unsubscribe", stream: "public" }, { type: "subscribe", stream: "user" });
    assertEquals(session.streams(), ["hashtag#ab", "hashtag#é😀a", "user"]);
});

Deno.test("a client's streams are limited as config is by default", () => {
    const { session, sent, send } = open(["read"]);
    for (let i = 0; i < 101; i++) send({ type: "subscribe", stream: "hashtag", tag: `t${i}` });
    send({ type: "subscribe", stream: "hashtag:local", tag: "a".repeat(101) });

    assertEquals(session.streams().length, 100);
    assertEquals(sent, [
        { error: "Too many subscriptions", status: 400 },
        { error: "Tag name is too long", status: 400 },
    ]);
});
