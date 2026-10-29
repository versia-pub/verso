import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import { mute } from "../graph/mutes.ts";
import type { Context } from "../kernel/context.ts";
import type { Permission } from "../kernel/permissions.ts";
import type { Scope } from "../kernel/scopes.ts";
import { editNote, postNote } from "../notes/notes.ts";
import { removeNote } from "../notes/removal.ts";
import { createTestContext } from "../testing/context.ts";
import { openSession } from "./session.ts";
import { dispatcher } from "./dispatcher.ts";
import { streamUser } from "./user.ts";

const open = async () => {
    const test = await createTestContext();
    const dispatch = dispatcher(test.ctx);
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "alice", "bob");

    /** What `accountId` is sent on `streams`, as each event's stream, type, and status or id. */
    const streaming = (
        accountId: string,
        streams: readonly string[],
        options: {
            scopes?: readonly Scope[];
            ctx?: Context;
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
                const shown = event === "delete" ? payload : JSON.parse(payload);
                sent.push([stream.join(), event, shown.status?.id ?? shown.id ?? shown]);
            },
            close: () => {},
        });
        for (const stream of streams) {
            session.receive(JSON.stringify({ type: "subscribe", stream }));
        }

        return {
            sent,
            stop: dispatch.listen(streamUser(options.ctx ?? test.ctx, viewer, session)),
        };
    };

    const post = async (accountId: string, text: string, visibility?: "direct" | "private") => {
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

    return { ...test, dispatch, streaming, post };
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

Deno.test("a user's session reads nothing for streams it isn't subscribed to, or others' notifications", async () => {
    await using test = await open();
    let reads = 0;
    const db = new Proxy(test.ctx.db, {
        get: (target, name) => {
            if (name === "selectFrom") reads++;
            return Reflect.get(target, name);
        },
    });
    const counted = { ...test.ctx, db };
    test.streaming("alice", ["public"], { ctx: counted });
    test.streaming("bob", ["user:notification"], { ctx: counted });

    const note = await test.post("bob", "Hi @alice");
    await removeNote(test.ctx, note);
    await test.dispatch.idle();

    assertEquals(reads, 0);
});
