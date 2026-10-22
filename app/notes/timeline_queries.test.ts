import { assertEquals } from "@std/assert";
import type { Insertable } from "kysely";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { follow, followedSubquery, sharingSubquery } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import type { NotesTable } from "./tables.ts";
import { createNote, createShare } from "./testing.ts";
import { homePage, type Origin, publicPage } from "./timeline_queries.ts";

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
        (await homePage(
            test.ctx,
            "alice",
            followedSubquery(test.ctx, "alice"),
            sharingSubquery(test.ctx, "alice"),
            { limit: 40, ...page },
        ))
            .map((note) => names.get(note.id) ?? note.id);

    /** Adds a share called `name` by `accountId` of the note called `shared`. */
    const share = async (name: string, accountId: string, shared: string) => {
        test.clock.advance(1);
        const [noteId] = [...names].find(([, each]) => each === shared) ?? [];
        names.set((await createShare(test.ctx, accountId, noteId ?? "")).id, name);
    };

    /** The public timeline from `origin`, by name. */
    const everyone = async (origin: Origin = "all", page: { max_id?: string } = {}) =>
        (await publicPage(test.ctx, origin, { limit: 40, ...page }))
            .map((note) => names.get(note.id) ?? note.id);

    return { ...test, add, share, home, everyone, names };
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

Deno.test("home has the viewer's shares, and those of the accounts they see the shares of", async () => {
    await using test = await open();
    await test.add("note", "dave");
    await test.share("own", "alice", "note");
    await test.share("bob's", "bob", "note");
    await test.share("carol's", "carol", "note");
    await test.share("dave's", "dave", "note");
    await test.share("erin's", "erin", "note");
    await test.ctx.db.updateTable("follows").set({ show_reblogs: false })
        .where("followee_id", "=", "carol").execute();

    assertEquals(await test.home(), ["bob's", "own"]);
});

Deno.test("home is paged by id", async () => {
    await using test = await open();
    for (const name of ["one", "two", "three"]) await test.add(name, "bob");
    const [three] = [...test.names].find(([, name]) => name === "three") ?? [];

    assertEquals(await test.home({ limit: 2 }), ["three", "two"]);
    assertEquals(await test.home({ max_id: three }), ["two", "one"]);
});

Deno.test("the public timeline is public notes, without replies but to their own authors", async () => {
    await using test = await open();
    await test.add("shared", "bob", { visibility: "unlisted" });
    await test.share("share", "dave", "shared");
    await test.add("public", "dave");
    await test.add("unlisted", "dave", { visibility: "unlisted" });
    await test.add("private", "dave", { visibility: "private" });
    await test.add("direct", "dave", { visibility: "direct" });
    await test.add("to self", "dave", replyTo("dave"));
    await test.add("to bob", "dave", replyTo("bob"));
    await test.add("remote", "carol", { instance_id: "b.example", remote_id: "c1" });
    await test.add("remote to self", "carol", {
        ...replyTo("carol"),
        instance_id: "b.example",
        remote_id: "c2",
    });

    assertEquals(await test.everyone(), ["remote to self", "remote", "to self", "public"]);
    assertEquals(await test.everyone("local"), ["to self", "public"]);
    assertEquals(await test.everyone("remote"), ["remote to self", "remote"]);

    const [remote] = [...test.names].find(([, name]) => name === "remote") ?? [];
    assertEquals(await test.everyone("all", { max_id: remote }), ["to self", "public"]);
});
