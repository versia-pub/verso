import { assertEquals } from "@std/assert";
import type { Insertable } from "kysely";
import type { Visibility } from "../accounts/tables.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { block } from "../graph/blocks.ts";
import { mute } from "../graph/mutes.ts";
import { createInstance } from "../instances/testing.ts";
import type { Permission } from "../kernel/permissions.ts";
import { publish } from "../kernel/pubsub.ts";
import type { NotesTable } from "../notes/tables.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { dispatcher } from "./dispatcher.ts";
import { hashtagStreams } from "./hashtags.ts";
import { openSession } from "./session.ts";
import type { SharedSessions } from "./shared.ts";
import { type StatusMessage, statusMessages } from "./statuses.ts";

/** The `hashtag` and `hashtag:local` streams of #nix and #rust. */
const everyStream = [
    ["hashtag", "nix"],
    ["hashtag:local", "nix"],
    ["hashtag", "rust"],
    ["hashtag:local", "rust"],
];

const open = async () => {
    const test = await createTestContext();
    const dispatch = dispatcher(test.ctx);
    const shared = hashtagStreams(test.ctx);
    dispatch.listen(shared);
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");

    /**
     * What `accountId` is sent on `streams`, as each event's stream, type, and status or id. Its
     * session is added to the test's hashtag streams, or `options.sessions`.
     */
    const streaming = (
        accountId: string,
        streams: readonly string[][] = everyStream,
        options: { sessions?: SharedSessions; permissions?: readonly Permission[] } = {},
    ) => {
        const sent: unknown[] = [];
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
                sent.push([
                    stream.join(),
                    event,
                    event === "delete" ? payload : JSON.parse(payload).id,
                ]);
            },
            close: () => {},
        });
        for (const [stream, tag] of streams) {
            session.receive(JSON.stringify({ type: "subscribe", stream, tag }));
        }

        return { sent, stop: (options.sessions ?? shared).add(viewer, session) };
    };

    /** Publishes `message`, and waits until it is streamed. */
    const published = async (message: StatusMessage) => {
        await publish(test.ctx, statusMessages, message);
        await dispatch.idle();
    };

    /** Adds a status using `tags`, as `createNote` does, and says it appeared. */
    const post = async (
        accountId: string,
        tags: readonly string[],
        note: Partial<Insertable<NotesTable>> = {},
    ) => {
        const { id } = await createNote(test.ctx, accountId, note, [], tags);
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

    return { ...test, dispatch, streaming, post, deleted, published };
};

Deno.test("public statuses are sent on the streams of each hashtag they use, for where they are from", async () => {
    await using test = await open();
    const alice = test.streaming("alice");
    const local = test.streaming("alice", [["hashtag:local", "rust"]]);

    const both = await test.post("bob", ["nix", "rust"]);
    await test.published({ event: "status.update", noteId: both });
    const remote = await test.post("carol", ["nix"], { instance_id: "b.example", remote_id: "c1" });
    // Replies too.
    const reply = await test.post("bob", ["rust"], {
        in_reply_to_id: remote,
        in_reply_to_account_id: "carol",
    });

    assertEquals(alice.sent, [
        ["hashtag,nix", "update", both],
        ["hashtag:local,nix", "update", both],
        ["hashtag,rust", "update", both],
        ["hashtag:local,rust", "update", both],
        ["hashtag,nix", "status.update", both],
        ["hashtag:local,nix", "status.update", both],
        ["hashtag,rust", "status.update", both],
        ["hashtag:local,rust", "status.update", both],
        ["hashtag,nix", "update", remote],
        ["hashtag,rust", "update", reply],
        ["hashtag:local,rust", "update", reply],
    ]);
    assertEquals(local.sent, [
        ["hashtag:local,rust", "update", both],
        ["hashtag:local,rust", "status.update", both],
        ["hashtag:local,rust", "update", reply],
    ]);
});

Deno.test("only public statuses using hashtags are sent, and only deletes of public ones", async () => {
    await using test = await open();
    const alice = test.streaming("alice");

    const unlisted = await test.post("bob", ["nix"], { visibility: "unlisted" });
    await test.post("bob", ["go"]);
    const untagged = await test.post("bob", []);
    const share = await createShare(test.ctx, "bob", untagged);
    await test.published({ event: "update", noteId: share.id });
    await test.deleted(unlisted, "unlisted");
    await test.deleted(untagged);

    // As deleted statuses are gone, a delete is sent on every stream subscribed to.
    assertEquals(alice.sent, everyStream.map((stream) => [stream.join(), "delete", untagged]));
});

Deno.test("the statuses of the accounts a viewer blocks or mutes aren't sent, but their deletes are", async () => {
    await using test = await open();
    const alice = test.streaming("alice", [["hashtag", "nix"]]);
    const bob = test.streaming("bob", [["hashtag", "nix"]]);
    await block(test.ctx, "alice", "carol");
    await mute(test.ctx, "bob", "alice", { notifications: false, duration: 0 });

    const carols = await test.post("carol", ["nix"], { instance_id: "b.example", remote_id: "c1" });
    const alices = await test.post("alice", ["nix"]);
    await test.deleted(carols);

    assertEquals(alice.sent, [["hashtag,nix", "update", alices], [
        "hashtag,nix",
        "delete",
        carols,
    ]]);
    assertEquals(bob.sent, [["hashtag,nix", "update", carols], ["hashtag,nix", "delete", carols]]);
});

Deno.test("hashtag streams send nothing to those who may not read statuses, or who stopped", async () => {
    await using test = await open();
    const limited = test.streaming("alice", everyStream, { permissions: ["read:account"] });
    const stopped = test.streaming("alice");
    stopped.stop();

    const note = await test.post("bob", ["nix"]);
    await test.deleted(note);

    assertEquals([limited.sent, stopped.sent], [[], []]);
});

Deno.test("a session reads nothing for hashtag streams it isn't subscribed to", async () => {
    await using test = await open();
    let queries = 0;
    const db = test.ctx.db.withPlugin({
        transformQuery: ({ node }) => node,
        transformResult: ({ result }) => {
            queries += 1;
            return Promise.resolve(result);
        },
    });
    const sessions = hashtagStreams({ ...test.ctx, db });
    test.dispatch.listen(sessions);
    test.streaming("alice", [["public"]], { sessions });
    test.streaming("bob", [["hashtag", "nix"]], { sessions, permissions: ["read:account"] });

    await test.post("bob", ["nix"]);
    await test.deleted("gone");

    assertEquals(queries, 0);
});
