import { configure, type LogRecord, reset } from "@logtape/logtape";
import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import { mute } from "../graph/mutes.ts";
import type { Permission } from "../kernel/permissions.ts";
import type { Scope } from "../kernel/scopes.ts";
import { editNote, postNote } from "../notes/notes.ts";
import { removeNote } from "../notes/removal.ts";
import { publish } from "../kernel/pubsub.ts";
import { followTag } from "../tags/tag_follows.ts";
import { createFilter, removeFilter } from "../filters/filters.ts";
import { createTestContext } from "../testing/context.ts";
import { openSession } from "./session.ts";
import { dispatcher, type Sessions } from "./dispatcher.ts";
import { statusMessages } from "./statuses.ts";
import { userStreams } from "./user.ts";

const open = async () => {
    const test = await createTestContext();
    const dispatch = dispatcher(test.ctx);
    const shared = userStreams(test.ctx);
    dispatch.listen(shared);
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "alice", "bob");
    // What failed to stream, which nothing should.
    const failed: LogRecord[] = [];
    await configure({
        reset: true,
        sinks: { buffer: (record) => failed.push(record) },
        loggers: [
            { category: ["verso", "streaming"], sinks: ["buffer"] },
            { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
        ],
    });

    /**
     * What `accountId` is sent on `streams`, as each event's stream, type, and status or id. Its
     * session is added to the test's user streams, or `options.sessions`.
     */
    const streaming = (
        accountId: string,
        streams: readonly string[],
        options: {
            scopes?: readonly Scope[];
            sessions?: Sessions;
            permissions?: readonly Permission[];
        } = {},
    ) => {
        const sent: unknown[] = [];
        const viewer = {
            tokenId: "token",
            appId: "app",
            accountId,
            scopes: options.scopes ?? ["read"],
            forgetPermissions: () => {},
            permissions: () =>
                Promise.resolve(
                    new Set<Permission>(
                        options.permissions ?? ["read:note", "owner:notification"],
                    ),
                ),
        };
        const session = openSession(viewer, {
            send: (data) => {
                const { stream, event, payload } = JSON.parse(data);
                // A delete's payload is an id, and `filters_changed` has none.
                const shown = event === "delete" || payload === undefined
                    ? payload
                    : JSON.parse(payload);
                sent.push([stream.join(), event, shown?.status?.id ?? shown?.id ?? shown]);
            },
            close: () => {},
        });
        for (const stream of streams) {
            session.receive(JSON.stringify({ type: "subscribe", stream }));
        }

        return {
            sent,
            stop: (options.sessions ?? shared).add(viewer, session),
        };
    };

    const post = async (
        accountId: string,
        text: string,
        visibility?: "direct" | "private" | "unlisted",
    ) => {
        const note = await postNote(test.ctx, accountId, {
            text,
            format: "text/plain",
            spoilerText: "",
            visibility,
        });
        if (note === undefined) throw new Error("Not posted");
        await dispatch.idle();
        return note.id;
    };

    /** User streams of their own, and how many queries they have made. */
    const counted = () => {
        let queries = 0;
        const db = test.ctx.db.withPlugin({
            transformQuery: ({ node }) => node,
            transformResult: ({ result }) => {
                queries += 1;
                return Promise.resolve(result);
            },
        });
        const sessions = userStreams({ ...test.ctx, db });
        dispatch.listen(sessions);
        return { sessions, queries: () => queries };
    };

    return {
        ...test,
        dispatch,
        streaming,
        counted,
        post,
        failed,
        [Symbol.asyncDispose]: async () => {
            await reset();
            await test[Symbol.asyncDispose]();
        },
    };
};

Deno.test("a user is sent the statuses of their home timeline as they are posted, edited and deleted", async () => {
    await using test = await open();
    const alice = test.streaming("alice", ["user"]);
    const bob = test.streaming("bob", ["user"]);
    // Not following bob.
    const carol = test.streaming("carol", ["user"]);
    const elsewhere = test.streaming("alice", ["public"]);

    const note = await test.post("bob", "Hi");
    await editNote(test.ctx, "bob", note, { text: "Hello" });
    await test.dispatch.idle();
    await removeNote(test.ctx, note);
    await test.dispatch.idle();

    const told = [["user", "update", note], ["user", "status.update", note], [
        "user",
        "delete",
        note,
    ]];
    assertEquals([alice.sent, bob.sent], [told, told]);
    assertEquals([carol.sent, elsewhere.sent], [[], []]);
});

Deno.test("a user is told on the user stream when their filters change", async () => {
    await using test = await open();
    const alice = test.streaming("alice", ["user"]);
    const notifications = test.streaming("alice", ["user:notification"]);
    const bob = test.streaming("bob", ["user"]);

    const filter = await createFilter(test.ctx, "alice", {
        title: "Pets",
        context: ["home"],
        action: "warn",
        expiresIn: null,
    }, []);
    await removeFilter(test.ctx, "alice", filter.id);
    await test.dispatch.idle();

    const told = ["user", "filters_changed", undefined];
    assertEquals([alice.sent, notifications.sent, bob.sent], [[told, told], [], []]);
});

Deno.test("a user is told of statuses they may see, and those deleted that they could", async () => {
    await using test = await open();
    const alice = test.streaming("alice", ["user"]);
    const carol = test.streaming("carol", ["user"]);
    await follow(test.ctx, "carol", "bob");
    await mute(test.ctx, "carol", "bob", { notifications: false, duration: 0 });

    const direct = await test.post("bob", "Hi", "direct");
    const mentioning = await test.post("bob", "Hi @alice", "direct");
    // carol muted bob, so isn't sent his statuses, though she is told those deleted.
    const shown = await test.post("bob", "Hi", "private");
    for (const note of [direct, mentioning, shown]) await removeNote(test.ctx, note);
    await test.dispatch.idle();

    assertEquals(alice.sent, [
        // Her token may read notifications.
        ["user", "notification", mentioning],
        ["user", "update", mentioning],
        ["user", "update", shown],
        ["user", "delete", mentioning],
        ["user", "delete", shown],
    ]);
    assertEquals(carol.sent, [["user", "delete", shown]]);
    assertEquals(test.failed, []);
});

Deno.test("a user is sent their notifications on each stream for them, if their token may read them", async () => {
    await using test = await open();
    const both = test.streaming("alice", ["user:notification", "user", "public"]);
    const statuses = test.streaming("alice", ["user"], { scopes: ["read:statuses"] });

    const note = await test.post("carol", "Hi @alice");
    // Of bob's, not alice's.
    await test.post("carol", "Hi @bob");

    assertEquals(both.sent, [["user:notification", "notification", note], [
        "user",
        "notification",
        note,
    ]]);
    assertEquals(statuses.sent, []);
});

Deno.test("a user is sent no statuses unless they may read them, nor notifications unless they may read theirs", async () => {
    await using test = await open();
    const notes = ["user", "user:notification"];
    const noStatuses = test.streaming("alice", notes, { permissions: ["owner:notification"] });
    const noNotifications = test.streaming("alice", notes, { permissions: ["read:note"] });

    const note = await test.post("bob", "Hi @alice");
    await removeNote(test.ctx, note);
    await test.dispatch.idle();

    assertEquals(noStatuses.sent, [
        ["user", "notification", note],
        ["user:notification", "notification", note],
    ]);
    assertEquals(noNotifications.sent, [["user", "update", note], ["user", "delete", note]]);
});

Deno.test("a user is sent nothing once they stop streaming", async () => {
    await using test = await open();
    const alice = test.streaming("alice", ["user", "user:notification"]);

    alice.stop();
    await test.post("bob", "Hi @alice");

    assertEquals(alice.sent, []);
});

Deno.test("a user isn't told of the statuses of those they only asked to follow, nor of statuses gone", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "carol")
        .execute();
    await follow(test.ctx, "bob", "carol");
    const bob = test.streaming("bob", ["user"]);

    const note = await test.post("carol", "Hi", "private");
    await removeNote(test.ctx, note);
    await publish(test.ctx, statusMessages, { event: "status.update", noteId: note });
    await test.dispatch.idle();

    assertEquals(bob.sent, []);
    assertEquals(test.failed, []);
});

Deno.test("a user is sent the public statuses with the hashtags they follow, and told of those deleted", async () => {
    await using test = await open();
    await followTag(test.ctx, "carol", "cats");
    const carol = test.streaming("carol", ["user"]);

    const shown = await test.post("bob", "Hi #Cats");
    const unlisted = await test.post("bob", "Hi #cats", "unlisted");
    await test.post("bob", "Hi #dogs");
    for (const note of [shown, unlisted]) await removeNote(test.ctx, note);
    await test.dispatch.idle();

    assertEquals(carol.sent, [["user", "update", shown], ["user", "delete", shown]]);
    assertEquals(test.failed, []);
});

Deno.test("a status is looked up for its author and their followers only, once for each", async () => {
    await using test = await open();
    const one = test.counted();
    test.streaming("alice", ["user"], { sessions: one.sessions });
    // alice twice more, asked about once, and as many who don't follow bob, nor exist, as one
    // query asks about with her.
    const many = test.counted();
    const viewers = ["alice", "alice", ...Array.from({ length: 999 }, (_, n) => `nobody${n}`)];
    const sent = viewers.map((accountId) =>
        test.streaming(accountId, ["user"], { sessions: many.sessions }).sent
    );

    const note = await test.post("bob", "Hi");
    await removeNote(test.ctx, note);
    await test.dispatch.idle();

    const told = [["user", "update", note], ["user", "delete", note]];
    assertEquals(sent.slice(0, 2), [told, told]);
    assertEquals(sent.slice(2).flat(), []);
    assertEquals(many.queries(), one.queries());
});

Deno.test("a notification is rendered once for each viewer, however many sessions they have", async () => {
    await using test = await open();
    const one = test.counted();
    test.streaming("alice", ["user:notification"], { sessions: one.sessions });
    const many = test.counted();
    const sent = [1, 2].map(() =>
        test.streaming("alice", ["user:notification"], { sessions: many.sessions }).sent
    );

    const note = await test.post("carol", "Hi @alice");

    const told = [["user:notification", "notification", note]];
    assertEquals(sent, [told, told]);
    assertEquals(many.queries(), one.queries());
});

Deno.test("a user's session reads nothing for streams it isn't subscribed to, or others' notifications", async () => {
    await using test = await open();
    const { sessions, queries } = test.counted();
    test.streaming("alice", ["public"], { sessions });
    test.streaming("bob", ["user:notification"], { sessions });

    const note = await test.post("bob", "Hi @alice");
    await removeNote(test.ctx, note);
    await test.dispatch.idle();

    assertEquals(queries(), 0);
});
