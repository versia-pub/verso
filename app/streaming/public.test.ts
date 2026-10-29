import { configure, type LogRecord, reset } from "@logtape/logtape";
import { assertEquals } from "@std/assert";
import type { Insertable } from "kysely";
import type { Visibility } from "../accounts/tables.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { block } from "../graph/blocks.ts";
import { blockDomainFor } from "../graph/domain_blocks.ts";
import { mute } from "../graph/mutes.ts";
import { createInstance } from "../instances/testing.ts";
import { like } from "../interactions/likes.ts";
import type { Permission } from "../kernel/permissions.ts";
import { publish } from "../kernel/pubsub.ts";
import { insertAttachments } from "../media/attachment_queries.ts";
import { saveRemoteMedia } from "../media/media_queries.ts";
import type { NotesTable } from "../notes/tables.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { dispatcher } from "./dispatcher.ts";
import { publicStreams } from "./public.ts";
import { openSession } from "./session.ts";
import type { SharedSessions } from "./shared.ts";
import { type StatusMessage, statusMessages } from "./statuses.ts";

const everyStream = [
    "public",
    "public:media",
    "public:local",
    "public:local:media",
    "public:remote",
    "public:remote:media",
];

const open = async () => {
    const test = await createTestContext();
    const dispatch = dispatcher(test.ctx);
    const shared = publicStreams(test.ctx);
    dispatch.listen(shared);
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");

    /**
     * What `accountId` is sent on `streams`, as each event's stream, type, and status or id, and
     * each status sent. Its session is added to the test's public streams, or `options.sessions`.
     */
    const streaming = (
        accountId: string,
        streams: readonly string[] = everyStream,
        options: { sessions?: SharedSessions; permissions?: readonly Permission[] } = {},
    ) => {
        const sent: unknown[] = [];
        const statuses: Record<string, unknown>[] = [];
        const viewer = {
            tokenId: "token",
            appId: "app",
            accountId,
            scopes: ["read"] as const,
            forgetPermissions: () => {},
            permissions: () =>
                Promise.resolve(new Set<Permission>(options.permissions ?? ["read:note"])),
        };
        const session = openSession(viewer, {
            send: (data) => {
                const { stream, event, payload } = JSON.parse(data);
                if (event !== "delete") statuses.push(JSON.parse(payload));
                sent.push([
                    stream.join(),
                    event,
                    event === "delete" ? payload : JSON.parse(payload).id,
                ]);
            },
            close: () => {},
        });
        for (const stream of streams) {
            session.receive(JSON.stringify({ type: "subscribe", stream }));
        }

        return { sent, statuses, stop: (options.sessions ?? shared).add(viewer, session) };
    };

    /** Public streams of their own, and how many queries they have made. */
    const counted = () => {
        let queries = 0;
        const db = test.ctx.db.withPlugin({
            transformQuery: ({ node }) => node,
            transformResult: ({ result }) => {
                queries += 1;
                return Promise.resolve(result);
            },
        });
        const sessions = publicStreams({ ...test.ctx, db });
        dispatch.listen(sessions);
        return { sessions, queries: () => queries };
    };

    /** Publishes `message`, and waits until it is streamed. */
    const published = async (message: StatusMessage) => {
        await publish(test.ctx, statusMessages, message);
        await dispatch.idle();
    };

    /** Adds a status, as `createNote` does, and says it appeared. */
    const post = async (accountId: string, note: Partial<Insertable<NotesTable>> = {}) => {
        const { id } = await createNote(test.ctx, accountId, note);
        await published({ event: "update", noteId: id });
        return id;
    };

    /** Says the status `noteId` was deleted, as it would if it were `visibility`. */
    const deleted = async (noteId: string, visibility: Visibility = "public") =>
        await published({
            event: "delete",
            noteId,
            accountId: "bob",
            visibility,
            mentionIds: [],
        });

    return { ...test, streaming, counted, post, deleted, published };
};

Deno.test("public statuses are sent on the public streams for where they are from", async () => {
    await using test = await open();
    const alice = test.streaming("alice");
    const local = test.streaming("alice", ["public:local"]);

    const note = await test.post("bob");
    await test.published({ event: "status.update", noteId: note });
    const remote = await test.post("carol", { instance_id: "b.example", remote_id: "c1" });
    const media = await saveRemoteMedia(test.ctx, "b.example", null, {
        url: "https://b.example/carol.png",
        mediaType: "image/png",
    });
    const pictured = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "c2",
    });
    await insertAttachments(test.ctx, pictured.id, [media]);
    await test.published({ event: "update", noteId: pictured.id });

    assertEquals(alice.sent, [
        ["public", "update", note],
        ["public:local", "update", note],
        ["public", "status.update", note],
        ["public:local", "status.update", note],
        ["public", "update", remote],
        ["public:remote", "update", remote],
        ["public", "update", pictured.id],
        ["public:media", "update", pictured.id],
        ["public:remote", "update", pictured.id],
        ["public:remote:media", "update", pictured.id],
    ]);
    assertEquals(local.sent, [["public:local", "update", note], [
        "public:local",
        "status.update",
        note,
    ]]);
});

Deno.test("only statuses of the public timeline are sent, and only deletes of public ones", async () => {
    await using test = await open();
    const alice = test.streaming("alice");
    const logged: LogRecord[] = [];
    await configure({
        reset: true,
        sinks: { buffer: (record) => logged.push(record) },
        loggers: [
            { category: ["verso", "streaming"], sinks: ["buffer"] },
            { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
        ],
    });
    await using _ = { [Symbol.asyncDispose]: reset };

    const unlisted = await test.post("bob", { visibility: "unlisted" });
    const reply = await test.post("bob", {
        in_reply_to_id: unlisted,
        in_reply_to_account_id: "alice",
    });
    const share = await createShare(test.ctx, "bob", unlisted);
    await test.published({ event: "update", noteId: share.id });
    await test.deleted(unlisted, "unlisted");
    await test.deleted(reply);

    // As deleted statuses are gone, a delete is sent on every stream subscribed to.
    assertEquals(alice.sent, everyStream.map((stream) => [stream, "delete", reply]));
    // Those passed over didn't fail.
    assertEquals(logged, []);
});

Deno.test("statuses are rendered as anyone sees them", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "dave");
    const alice = test.streaming("alice", ["public"]);
    const note = await test.post("bob");
    await block(test.ctx, "alice", "dave");
    await like(test.ctx, "alice", note);
    await like(test.ctx, "dave", note);

    await test.published({ event: "status.update", noteId: note });

    // Without whether it is liked, as nobody is viewing, and with the like of the account alice
    // blocks.
    const [, edited] = alice.statuses;
    assertEquals(["favourited" in edited, edited.favourites_count], [false, 2]);
});

Deno.test("the statuses of the accounts a viewer blocks or mutes aren't sent, but their deletes are", async () => {
    await using test = await open();
    for (const id of ["dave", "erin", "frank"]) await createLocalAccount(test.ctx, id);
    const alice = test.streaming("alice", ["public"]);
    const bob = test.streaming("bob", ["public"]);
    const dave = test.streaming("dave", ["public"]);
    const erin = test.streaming("erin", ["public"]);
    const frank = test.streaming("frank", ["public"]);
    await block(test.ctx, "alice", "carol");
    await mute(test.ctx, "bob", "alice", { notifications: false, duration: 0 });
    await blockDomainFor(test.ctx, "dave", "b.example");
    await blockDomainFor(test.ctx, "erin", "example");
    // A mute that has ended.
    await mute(test.ctx, "frank", "carol", { notifications: false, duration: 60 });
    test.clock.advance(60_000);

    const carols = await test.post("carol", { instance_id: "b.example", remote_id: "c1" });
    const alices = await test.post("alice");
    await test.deleted(carols);

    const hidden = [["public", "update", alices], ["public", "delete", carols]];
    assertEquals(alice.sent, hidden);
    assertEquals(bob.sent, [["public", "update", carols], ["public", "delete", carols]]);
    assertEquals([dave.sent, erin.sent], [hidden, hidden]);
    assertEquals(frank.sent, [
        ["public", "update", carols],
        ["public", "update", alices],
        ["public", "delete", carols],
    ]);
});

Deno.test("a status is looked up and rendered once, however many sessions it is sent to", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "dave");
    const one = test.counted();
    test.streaming("alice", ["public"], { sessions: one.sessions });
    // Each viewer is asked about once, however many sessions they have.
    const many = test.counted();
    const viewers = [...Array(1000).fill("alice"), "bob", "dave"];
    const sent = viewers.map((accountId) =>
        test.streaming(accountId, ["public:local"], { sessions: many.sessions }).sent
    );

    const note = await test.post("bob");

    assertEquals(sent, Array(1002).fill([["public:local", "update", note]]));
    assertEquals(many.queries(), one.queries());
});

Deno.test("public streams send nothing to those who may not read statuses, or who stopped", async () => {
    await using test = await open();
    const limited = test.streaming("alice", ["public"], { permissions: ["read:account"] });
    const stopped = test.streaming("alice", ["public"]);
    stopped.stop();

    const note = await test.post("bob");
    await test.deleted(note);

    assertEquals([limited.sent, stopped.sent], [[], []]);
});

Deno.test("a session reads nothing for public streams it isn't subscribed to", async () => {
    await using test = await open();
    const { sessions, queries } = test.counted();
    test.streaming("alice", ["user"], { sessions });
    test.streaming("bob", ["public"], { sessions, permissions: ["read:account"] });

    await test.post("bob");
    await test.deleted("gone");

    assertEquals(queries(), 0);
});
