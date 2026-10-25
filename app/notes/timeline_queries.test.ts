import { assertEquals } from "@std/assert";
import type { Insertable } from "kysely";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { block } from "../graph/blocks.ts";
import { follow, followedSubquery, sharingSubquery } from "../graph/follows.ts";
import { hiddenFrom } from "../graph/hidden.ts";
import { mute } from "../graph/mutes.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import type { NotesTable } from "./tables.ts";
import { createNote, createShare } from "./testing.ts";
import type { PageBounds } from "../db/paging.ts";
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
    const home = async (page: Partial<PageBounds> = {}) =>
        (await homePage(
            test.ctx,
            "alice",
            followedSubquery(test.ctx, "alice"),
            sharingSubquery(test.ctx, "alice"),
            hiddenFrom(test.ctx, "alice"),
            { limit: 40, ...page },
        ))
            .map((note) => names.get(note.id) ?? note.id);

    /** Adds a share called `name` by `accountId` of the note called `shared`. */
    const share = async (name: string, accountId: string, shared: string) => {
        test.clock.advance(1);
        const [noteId] = [...names].find(([, each]) => each === shared) ?? [];
        names.set((await createShare(test.ctx, accountId, noteId ?? "")).id, name);
    };

    /** The public timeline from `origin`, by name, as `viewerId` sees it, or anyone. */
    const everyone = async (
        origin: Origin = "all",
        page: { max_id?: string } = {},
        viewerId: string | null = null,
    ) => (await publicPage(
        test.ctx,
        origin,
        viewerId === null ? null : hiddenFrom(test.ctx, viewerId),
        { limit: 40, ...page },
    ))
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

Deno.test("home has nothing of the accounts the viewer blocks, nor others' shares of their notes", async () => {
    await using test = await open();
    await test.add("note", "bob");
    await test.add("dave's", "dave");
    await test.share("share", "bob", "dave's");
    await test.share("carol's share", "carol", "note");
    await test.share("carol's other share", "carol", "dave's");
    await test.add("carol's", "carol");
    await test.share("own share", "alice", "note");
    await block(test.ctx, "alice", "bob");
    // Blocked by someone else, carol is still seen.
    await block(test.ctx, "bob", "carol");

    assertEquals(await test.home(), ["carol's", "carol's other share"]);
});

Deno.test("home is paged by id", async () => {
    await using test = await open();
    for (const name of ["one", "two", "three"]) await test.add(name, "bob");
    const [three] = [...test.names].find(([, name]) => name === "three") ?? [];

    assertEquals(await test.home({ limit: 2 }), ["three", "two"]);
    assertEquals(await test.home({ max_id: three }), ["two", "one"]);
});

Deno.test("home's own notes, shares and others' notes are paged together", async () => {
    await using test = await open();
    await test.add("bob's", "bob");
    await test.add("first", "alice");
    await test.share("bob's share", "bob", "first");
    await test.add("bob's other", "bob");
    await test.add("second", "alice");
    const id = (name: string) => [...test.names].find(([, each]) => each === name)?.[0];

    assertEquals(await test.home({ limit: 3 }), ["second", "bob's other", "bob's share"]);
    assertEquals(await test.home({ limit: 2, max_id: id("bob's other") }), [
        "bob's share",
        "first",
    ]);
    assertEquals(await test.home({ limit: 2, since_id: id("first") }), ["second", "bob's other"]);
    assertEquals(await test.home({ limit: 2, min_id: id("first") }), [
        "bob's other",
        "bob's share",
    ]);
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

Deno.test("the public timeline leaves out the notes of the accounts the viewer blocks", async () => {
    await using test = await open();
    await test.add("bob's", "bob");
    await test.add("dave's", "dave");
    await block(test.ctx, "alice", "bob");

    assertEquals(await test.everyone("all", {}, "alice"), ["dave's"]);
    assertEquals(await test.everyone("all", {}, "dave"), ["dave's", "bob's"]);
    assertEquals(await test.everyone(), ["dave's", "bob's"]);
});

Deno.test("timelines leave out the accounts the viewer mutes, while the mute lasts", async () => {
    await using test = await open();
    await test.add("bob's", "bob");
    await test.add("dave's", "dave");
    await test.share("share", "carol", "dave's");
    await test.add("carol's", "carol");
    await mute(test.ctx, "alice", "bob", { notifications: true, duration: 0 });
    await mute(test.ctx, "alice", "dave", { notifications: false, duration: 60 });
    // Muted by someone else, carol is still seen.
    await mute(test.ctx, "bob", "carol", { notifications: true, duration: 0 });

    assertEquals(await test.home(), ["carol's"]);
    assertEquals(await test.everyone("all", {}, "alice"), ["carol's"]);
    assertEquals(await test.everyone(), ["carol's", "dave's", "bob's"]);

    test.clock.advance(60_000);
    assertEquals(await test.home(), ["carol's", "share"]);
    assertEquals(await test.everyone("all", {}, "alice"), ["carol's", "dave's"]);
});
