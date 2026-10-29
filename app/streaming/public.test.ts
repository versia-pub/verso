import { assertEquals } from "@std/assert";
import type { Insertable } from "kysely";
import type { Visibility } from "../accounts/tables.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { block } from "../graph/blocks.ts";
import { mute } from "../graph/mutes.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import type { Permission } from "../kernel/permissions.ts";
import { publish } from "../kernel/pubsub.ts";
import { insertAttachments } from "../media/attachment_queries.ts";
import { saveRemoteMedia } from "../media/media_queries.ts";
import type { NotesTable } from "../notes/tables.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { dispatcher } from "./dispatcher.ts";
import { streamPublic } from "./public.ts";
import { openSession } from "./session.ts";
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
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");

    /** What `accountId` is sent on `streams`, as each event's stream, type, and status or id. */
    const streaming = (
        accountId: string,
        streams: readonly string[] = everyStream,
        options: { ctx?: Context; permissions?: readonly Permission[] } = {},
    ) => {
        const sent: unknown[] = [];
        const liked: unknown[] = [];
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
                if (event !== "delete") liked.push(JSON.parse(payload).favourited);
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

        return {
            sent,
            liked,
            stop: dispatch.listen(streamPublic(options.ctx ?? test.ctx, viewer, session)),
        };
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

    return { ...test, streaming, post, deleted, published };
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
    // Rendered as alice sees them.
    assertEquals(new Set(alice.liked), new Set([false]));
    assertEquals(local.sent, [["public:local", "update", note], [
        "public:local",
        "status.update",
        note,
    ]]);
});

Deno.test("only statuses of the public timeline are sent, and only deletes of public ones", async () => {
    await using test = await open();
    const alice = test.streaming("alice");

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
});

Deno.test("the statuses of the accounts a viewer blocks or mutes aren't sent, but their deletes are", async () => {
    await using test = await open();
    const alice = test.streaming("alice", ["public"]);
    const bob = test.streaming("bob", ["public"]);
    await block(test.ctx, "alice", "carol");
    await mute(test.ctx, "bob", "alice", { notifications: false, duration: 0 });

    const carols = await test.post("carol", { instance_id: "b.example", remote_id: "c1" });
    const alices = await test.post("alice");
    await test.deleted(carols);

    assertEquals(alice.sent, [["public", "update", alices], ["public", "delete", carols]]);
    assertEquals(bob.sent, [["public", "update", carols], ["public", "delete", carols]]);
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
    let reads = 0;
    const db = new Proxy(test.ctx.db, {
        get: (target, name) => {
            if (name === "selectFrom") reads++;
            return Reflect.get(target, name);
        },
    });
    test.streaming("alice", ["user"], { ctx: { ...test.ctx, db } });

    await test.post("bob");

    assertEquals(reads, 0);
});
