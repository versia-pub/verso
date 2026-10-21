import { assertEquals } from "@std/assert";
import type { Insertable } from "kysely";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { follow, followedIds } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import type { NotesTable } from "./tables.ts";
import { createNote } from "./testing.ts";
import { homePage } from "./timeline_queries.ts";

/**
 * Alice, who follows bob and carol, on b.example, and asked to follow erin; and dave, whom she
 * doesn't follow.
 */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "dave", "erin"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "in", [
        "carol",
        "erin",
    ])
        .execute();
    for (const id of ["bob", "carol", "erin"]) await follow(test.ctx, "alice", id);
    await test.ctx.db.updateTable("follows").set({ accepted: true }).where(
        "followee_id",
        "=",
        "carol",
    )
        .execute();
    const names = new Map<string, string>();

    /** Adds a note called `name` by `accountId`, mentioning `mentionIds`. */
    const add = async (
        name: string,
        accountId: string,
        note: Partial<Insertable<NotesTable>> = {},
        mentionIds: string[] = [],
    ) => {
        test.clock.advance(1);
        names.set((await createNote(test.ctx, accountId, note, mentionIds)).id, name);
    };

    /** Alice's home timeline, by name. */
    const home = async (page: { max_id?: string; limit?: number } = {}) =>
        (await homePage(test.ctx, "alice", followedIds(test.ctx, "alice"), { limit: 40, ...page }))
            .map((note) => names.get(note.id) ?? note.id);

    return { ...test, add, home, names };
};

const replyTo = (accountId: string) => ({
    in_reply_to_id: null,
    in_reply_to_account_id: accountId,
});

Deno.test("home is the viewer's notes and those they follow, newest first", async () => {
    await using test = await open();
    await test.add("own", "alice");
    await test.add("own direct", "alice", { visibility: "direct" });
    await test.add("own reply", "alice", replyTo("dave"));
    await test.add("public", "bob");
    await test.add("unlisted", "bob", { visibility: "unlisted" });
    await test.add("private", "bob", { visibility: "private" });
    await test.add("remote", "carol");
    await test.add("unfollowed", "dave");
    await test.add("asked", "erin");

    assertEquals(await test.home(), [
        "remote",
        "private",
        "unlisted",
        "public",
        "own reply",
        "own direct",
        "own",
    ]);
});

Deno.test("home has others' direct notes that mention the viewer, and replies among those followed", async () => {
    await using test = await open();
    await test.add("direct", "bob", { visibility: "direct" }, ["dave"]);
    await test.add("direct to alice", "bob", { visibility: "direct" }, ["alice", "dave"]);
    await test.add("to self", "bob", replyTo("bob"));
    await test.add("to alice", "bob", replyTo("alice"));
    await test.add("to carol", "bob", replyTo("carol"));
    await test.add("to dave", "bob", replyTo("dave"));
    await test.add("to erin", "bob", replyTo("erin"));

    assertEquals(await test.home(), ["to carol", "to alice", "to self", "direct to alice"]);
});

Deno.test("home is paged by id", async () => {
    await using test = await open();
    for (const name of ["one", "two", "three"]) await test.add(name, "bob");
    const [three] = [...test.names].find(([, name]) => name === "three") ?? [];

    assertEquals(await test.home({ limit: 2 }), ["three", "two"]);
    assertEquals(await test.home({ max_id: three }), ["two", "one"]);
});
