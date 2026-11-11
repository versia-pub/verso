import { assertEquals, assertStringIncludes } from "@std/assert";
import { CompiledQuery, sql } from "kysely";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { testDatabaseKind } from "../db/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { dayMs } from "../kernel/clock.ts";
import type { Context } from "../kernel/context.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { createTestContext } from "../testing/context.ts";
import { pruneRemoteNotes, startPruning } from "./pruning.ts";
import { oldRemoteNotesQuery, prunableNotesQuery } from "./pruning_queries.ts";
import { createNote, createShare } from "./testing.ts";
import type { NotesTable } from "./tables.ts";
import type { Insertable } from "kysely";

/** alice here; carol, followed by alice, and dave on b.example. */
const open = async (settings: { remoteStatusMs?: number | null } = {}) => {
    const test = await createTestContext({ settings });
    await createInstance(test.ctx, "b.example");
    await createLocalAccount(test.ctx, "alice");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    await createRemoteAccount(test.ctx, "dave", "b.example");
    await follow(test.ctx, "alice", "carol");

    return test;
};

const follow = async (ctx: Context, followerId: string, followeeId: string, accepted = true) => {
    await ctx.db.insertInto("follows")
        .values({
            id: ctx.ids(),
            follower_id: followerId,
            followee_id: followeeId,
            accepted,
            created_at: ctx.clock.now(),
        })
        .execute();
};

/** A status by `accountId` on b.example. */
const remoteNote = async (
    ctx: Context,
    accountId: string,
    note: Partial<Insertable<NotesTable>> = {},
    mentionIds: readonly string[] = [],
) => {
    const id = ctx.ids();
    return (await createNote(
        ctx,
        accountId,
        { id, instance_id: "b.example", remote_id: id, ...note },
        mentionIds,
    )).id;
};

/** A boost by `accountId` on b.example of `noteId`. */
const remoteShare = async (
    ctx: Context,
    accountId: string,
    noteId: string,
    share: Partial<Insertable<NotesTable>> = {},
) => {
    const id = ctx.ids();
    return (await createShare(ctx, accountId, noteId, {
        id,
        instance_id: "b.example",
        remote_id: id,
        ...share,
    })).id;
};

/** Prunes what is older than now, as the command does, and returns the remote statuses left. */
const prune = async (ctx: Context, keepFollowed = true) => {
    await pruneRemoteNotes(ctx, { before: new Date(ctx.clock.now().getTime() + 1), keepFollowed });
    return await remoteNoteIds(ctx);
};

const remoteNoteIds = async (ctx: Context) =>
    (await ctx.db.selectFrom("notes").select("id").where("instance_id", "is not", null)
        .orderBy("id").execute()).map((row) => row.id);

/** A poll on `noteId`, voted on by `accountId`. */
const vote = async (ctx: Context, noteId: string, accountId: string) => {
    const pollId = ctx.ids();
    await ctx.db.insertInto("polls")
        .values({
            id: pollId,
            note_id: noteId,
            multiple: false,
            hide_totals: false,
            expires_at: null,
            voters_count: 1,
            created_at: ctx.clock.now(),
        })
        .execute();
    await ctx.db.insertInto("poll_votes")
        .values({
            id: ctx.ids(),
            poll_id: pollId,
            account_id: accountId,
            choice: 0,
            created_at: ctx.clock.now(),
        })
        .execute();
};

/** Who interacts with `noteId`, and how: on b.example with `instanceId`, or here with `null`. */
const like = (ctx: Context, noteId: string, accountId: string, instanceId: string | null) =>
    ctx.db.insertInto("likes")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            note_id: noteId,
            instance_id: instanceId,
            remote_id: instanceId && ctx.ids(),
            created_at: ctx.clock.now(),
        })
        .execute();

const react = (ctx: Context, noteId: string, accountId: string, instanceId: string | null) =>
    ctx.db.insertInto("reactions")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            note_id: noteId,
            text: "👍",
            emoji_id: null,
            instance_id: instanceId,
            remote_id: instanceId && ctx.ids(),
            created_at: ctx.clock.now(),
        })
        .execute();

/** Tags `noteId` with #verso, followed by `followerId` if given. */
const tag = async (ctx: Context, noteId: string, followerId?: string) => {
    await ctx.db.insertInto("tags").values({ name: "verso", display_name: "verso" })
        .execute();
    await ctx.db.insertInto("note_tags").values({ note_id: noteId, name: "verso" }).execute();
    if (followerId === undefined) return;

    await ctx.db.insertInto("tag_follows")
        .values({
            id: ctx.ids(),
            account_id: followerId,
            tag: "verso",
            created_at: ctx.clock.now(),
        })
        .execute();
};

/**
 * Each case gives dave's status `target` something, and says whether that keeps it, when follows
 * keep statuses and when they don't.
 */
const cases: readonly {
    name: string;
    given: (ctx: Context, target: string) => Promise<unknown>;
    kept: boolean;
    keptWithoutFollowed?: boolean;
}[] = [
    { name: "nothing", given: async () => {}, kept: false },
    {
        name: "a reply from anyone",
        given: (ctx, target) => remoteNote(ctx, "dave", { in_reply_to_id: target }),
        kept: true,
    },
    {
        name: "a boost here",
        given: (ctx, target) => createShare(ctx, "alice", target),
        kept: true,
    },
    {
        name: "an old boost from an unfollowed account",
        given: (ctx, target) => remoteShare(ctx, "dave", target),
        kept: false,
    },
    {
        name: "a boost since the cutoff",
        given: (ctx, target) =>
            remoteShare(ctx, "dave", target, {
                created_at: new Date(ctx.clock.now().getTime() + 1),
            }),
        kept: true,
    },
    {
        name: "an old boost from a followed account",
        given: (ctx, target) => remoteShare(ctx, "carol", target),
        kept: true,
        keptWithoutFollowed: false,
    },
    {
        name: "a quote here",
        given: (ctx, target) => createNote(ctx, "alice", { quote_id: target }),
        kept: true,
    },
    {
        name: "a quote from a followed account",
        given: (ctx, target) => remoteNote(ctx, "carol", { quote_id: target }),
        kept: true,
        keptWithoutFollowed: false,
    },
    {
        name: "a quote from an unfollowed account",
        given: (ctx, target) => remoteNote(ctx, "dave", { quote_id: target }),
        kept: false,
    },
    {
        name: "a pin",
        given: (ctx, target) =>
            ctx.db.insertInto("note_pins")
                .values({
                    id: ctx.ids(),
                    account_id: "dave",
                    note_id: target,
                    created_at: ctx.clock.now(),
                })
                .execute(),
        kept: true,
    },
    {
        name: "a bookmark",
        given: (ctx, target) =>
            ctx.db.insertInto("bookmarks")
                .values({
                    id: ctx.ids(),
                    account_id: "alice",
                    note_id: target,
                    created_at: ctx.clock.now(),
                })
                .execute(),
        kept: true,
    },
    {
        name: "a like here",
        given: (ctx, target) => like(ctx, target, "alice", null),
        kept: true,
    },
    {
        name: "a like from elsewhere",
        given: (ctx, target) => like(ctx, target, "carol", "b.example"),
        kept: false,
    },
    {
        name: "a reaction here",
        given: (ctx, target) => react(ctx, target, "alice", null),
        kept: true,
    },
    {
        name: "a reaction from elsewhere",
        given: (ctx, target) => react(ctx, target, "carol", "b.example"),
        kept: false,
    },
    {
        name: "a vote here",
        given: (ctx, target) => vote(ctx, target, "alice"),
        kept: true,
    },
    {
        name: "a vote from elsewhere",
        given: (ctx, target) => vote(ctx, target, "carol"),
        kept: false,
    },
    {
        name: "a follower here",
        given: (ctx) => follow(ctx, "alice", "dave"),
        kept: true,
        keptWithoutFollowed: false,
    },
    {
        name: "a follow request from here",
        given: (ctx) => follow(ctx, "alice", "dave", false),
        kept: false,
    },
    {
        name: "a hashtag followed here",
        given: (ctx, target) => tag(ctx, target, "alice"),
        kept: true,
        keptWithoutFollowed: false,
    },
    {
        name: "a hashtag followed by no one",
        given: (ctx, target) => tag(ctx, target),
        kept: false,
    },
    {
        name: "a follower elsewhere",
        given: (ctx) => follow(ctx, "carol", "dave"),
        kept: false,
    },
];

for (const { name, given, kept, keptWithoutFollowed = kept } of cases) {
    for (const keepFollowed of [true, false]) {
        Deno.test(`an old remote status with ${name} is ${(keepFollowed ? kept : keptWithoutFollowed) ? "kept" : "pruned"}${keepFollowed ? "" : " when followed accounts' aren't kept"}`, async () => {
            await using test = await open();
            const target = await remoteNote(test.ctx, "dave");
            await given(test.ctx, target);

            const left = await prune(test.ctx, keepFollowed);

            assertEquals(left.includes(target), keepFollowed ? kept : keptWithoutFollowed);
        });
    }
}

Deno.test("old remote statuses that refer here are kept", async () => {
    await using test = await open();
    const local = (await createNote(test.ctx, "alice")).id;
    const reply = await remoteNote(test.ctx, "dave", { in_reply_to_id: local });
    const share = await remoteShare(test.ctx, "dave", local);
    const quote = await remoteNote(test.ctx, "dave", { quote_id: local });
    const mention = await remoteNote(test.ctx, "dave", {}, ["alice"]);
    await remoteNote(test.ctx, "dave", {}, ["carol"]);

    assertEquals(await prune(test.ctx), [reply, share, quote, mention].toSorted());
});

Deno.test("local statuses and remote ones newer than the cutoff aren't pruned", async () => {
    await using test = await open();
    const local = (await createNote(test.ctx, "alice")).id;
    const fresh = await remoteNote(test.ctx, "dave", {
        created_at: new Date(test.clock.now().getTime() + 1),
    });

    assertEquals(await prune(test.ctx), [fresh]);
    assertEquals(
        (await test.ctx.db.selectFrom("notes").select("id").where("id", "=", local).execute())
            .length,
        1,
    );
});

Deno.test("pruning returns how many statuses it deleted", async () => {
    await using test = await open();
    const original = await remoteNote(test.ctx, "dave");
    await remoteShare(test.ctx, "dave", original);
    await remoteNote(test.ctx, "dave");

    const deleted = await pruneRemoteNotes(test.ctx, {
        before: new Date(test.clock.now().getTime() + 1),
        keepFollowed: true,
    });

    // The original, the other status and the boost; the boost isn't deleted twice.
    assertEquals([deleted, await remoteNoteIds(test.ctx)], [3, []]);
});

const countsOf = async (ctx: Context, noteId: string) => {
    const row = await ctx.db.selectFrom("notes").select(["replies_count", "shares_count"])
        .where("id", "=", noteId).executeTakeFirstOrThrow();
    return [row.replies_count, row.shares_count];
};

const statusesCount = async (ctx: Context, accountId: string) =>
    (await ctx.db.selectFrom("accounts").select("statuses_count").where("id", "=", accountId)
        .executeTakeFirstOrThrow()).statuses_count;

Deno.test("the counts of what is kept lose what is pruned, and so do their authors'", async () => {
    await using test = await open();
    // Kept by alice's bookmark, with replies and boosts that nothing keeps.
    const original = await remoteNote(test.ctx, "dave");
    await test.ctx.db.insertInto("bookmarks")
        .values({
            id: test.ctx.ids(),
            account_id: "alice",
            note_id: original,
            created_at: test.clock.now(),
        })
        .execute();
    await createRemoteAccount(test.ctx, "erin", "b.example");
    for (const replier of ["dave", "erin"]) {
        await remoteNote(test.ctx, replier, { in_reply_to_id: original });
    }
    await remoteNote(test.ctx, "erin", { in_reply_to_id: original, visibility: "private" });
    await test.ctx.db.updateTable("notes").set({ replies_count: 2 }).where("id", "=", original)
        .execute();
    // dave and erin each boost it, so a batch holds several accounts' boosts.
    await remoteShare(test.ctx, "dave", original);
    await remoteShare(test.ctx, "erin", original);
    // A status of erin's that dave boosts, pruned along with the boost, which is counted once.
    const pruned = await remoteNote(test.ctx, "erin");
    await remoteShare(test.ctx, "dave", pruned);
    // Kept by a bookmark, as a later batch's boost would be, but deleted with the status it boosts.
    const alsoPruned = await remoteNote(test.ctx, "erin");
    const kept = await remoteShare(test.ctx, "dave", alsoPruned);
    await test.ctx.db.insertInto("bookmarks")
        .values({
            id: test.ctx.ids(),
            account_id: "alice",
            note_id: kept,
            created_at: test.clock.now(),
        })
        .execute();
    // Direct statuses aren't counted, so erin has five.
    await remoteNote(test.ctx, "erin", { visibility: "direct" });
    await test.ctx.db.updateTable("accounts").set({ statuses_count: 5 }).where("id", "=", "erin")
        .execute();

    assertEquals(await prune(test.ctx), [original]);
    assertEquals(await countsOf(test.ctx, original), [0, 0]);
    assertEquals(await statusesCount(test.ctx, "dave"), 1);
    assertEquals(await statusesCount(test.ctx, "erin"), 0);
});

/** Adds `count` statuses by `accountId` on b.example, as quickly as the database allows. */
const addRemoteNotes = async (ctx: Context, accountId: string, count: number) => {
    const rows = Array.from({ length: count }, () => {
        const id = ctx.ids();
        return {
            id,
            account_id: accountId,
            instance_id: "b.example",
            remote_id: id,
            thread_id: id,
            visibility: "public" as const,
            content: "Hi",
            content_format: "text/plain" as const,
            content_html: "<p>Hi</p>",
            language: null,
            in_reply_to_id: null,
            in_reply_to_account_id: null,
            created_at: ctx.clock.now(),
            edited_at: null,
        };
    });
    await ctx.db.insertInto("notes").values(rows).execute();
};

Deno.test("the daily job prunes in batches, carrying on past what it keeps", async () => {
    await using test = await open({ remoteStatusMs: dayMs });
    // A batch's worth of carol's, kept as alice follows her, then one of dave's, after them.
    await addRemoteNotes(test.ctx, "carol", 500);
    test.clock.advance(1);
    const daves = await remoteNote(test.ctx, "dave");
    test.clock.advance(dayMs + 1);

    await startPruning(test.ctx);
    await drain(test.ctx, queues);

    const left = await remoteNoteIds(test.ctx);
    assertEquals([left.length, left.includes(daves)], [500, false]);
});

Deno.test("the daily job prunes only what is older than the configured days", async () => {
    await using test = await open({ remoteStatusMs: dayMs });
    await remoteNote(test.ctx, "dave");
    test.clock.advance(1);
    const newer = await remoteNote(test.ctx, "dave");
    test.clock.advance(dayMs);

    await startPruning(test.ctx);
    await drain(test.ctx, queues);

    assertEquals(await remoteNoteIds(test.ctx), [newer]);
});

Deno.test("without remote_status_days, the daily job prunes nothing", async () => {
    await using test = await open();
    const old = await remoteNote(test.ctx, "dave");
    test.clock.advance(1000 * dayMs);

    await startPruning(test.ctx);
    await drain(test.ctx, queues);

    assertEquals(await remoteNoteIds(test.ctx), [old]);
});

Deno.test("old remote statuses are found by when they were created", async () => {
    await using test = await open();
    const { db } = test.ctx;

    const old = oldRemoteNotesQuery(test.ctx, test.clock.now(), {
        createdAt: test.clock.now(),
        id: "0",
    }, 500).compile();
    if (testDatabaseKind === "sqlite") {
        const plan = await db.executeQuery<{ detail: string }>(
            CompiledQuery.raw(`explain query plan ${old.sql}`, [...old.parameters]),
        );
        assertStringIncludes(plan.rows.map((row) => row.detail).join("\n"), "notes_remote_by_age");
        return;
    }

    await sql`set enable_seqscan = off`.execute(db);
    const plan = await db.executeQuery(
        CompiledQuery.raw(`explain (format json) ${old.sql}`, [...old.parameters]),
    );
    assertStringIncludes(JSON.stringify(plan.rows), '"Index Name":"notes_remote_by_age"');
});

/**
 * Each table that refers to statuses, and why pruning may delete or clear what refers to one:
 * either a rule above keeps statuses that it refers to here, or losing it loses nothing local.
 * A new reference to statuses should be added here, after deciding which.
 */
const references: Record<string, "kept" | "harmless"> = {
    "bookmarks.note_id": "kept",
    "conversation_notes.note_id": "harmless",
    "conversations.last_note_id": "harmless",
    "filter_statuses.note_id": "harmless",
    "likes.note_id": "kept",
    "note_emojis.note_id": "harmless",
    "note_media.note_id": "harmless",
    "note_mentions.note_id": "kept",
    "note_pins.note_id": "kept",
    "note_preview_cards.note_id": "harmless",
    "note_search.note_id": "harmless",
    "note_tags.note_id": "kept",
    "note_versions.note_id": "harmless",
    "notes.in_reply_to_id": "kept",
    "notes.quote_id": "kept",
    "notes.reblog_of_id": "kept",
    "notification_requests.last_note_id": "harmless",
    "notifications.note_id": "harmless",
    "notifications.share_id": "harmless",
    "polls.note_id": "kept",
    "reactions.note_id": "kept",
    "remote_note_totals.note_id": "harmless",
    "reply_backfills.note_id": "harmless",
    "trending_statuses.note_id": "harmless",
};

Deno.test({
    name: "every reference to statuses is either kept or harmless to lose, and indexed",
    ignore: testDatabaseKind !== "sqlite",
    fn: async () => {
        await using test = await open();
        const rows = await sql<{ name: string; from: string; indexed: number }>`
            select m.name, p."from", exists (
                select 1 from pragma_index_list(m.name) l, pragma_index_info(l.name) i
                where l.partial = 0 and i.seqno = 0 and i.name = p."from"
            ) as indexed
            from sqlite_master m, pragma_foreign_key_list(m.name) p
            where m.type = 'table' and p."table" = 'notes'
        `.execute(test.ctx.db);

        assertEquals(
            rows.rows.map((row) => `${row.name}.${row.from}`).toSorted(),
            Object.keys(references).toSorted(),
        );
        // Otherwise deleting a status reads the whole table, to delete or clear what refers to it.
        assertEquals(rows.rows.filter((row) => !row.indexed), []);
    },
});

Deno.test({
    name: "what keeps a status is looked up by index, not by reading every row",
    ignore: testDatabaseKind !== "sqlite",
    fn: async () => {
        await using test = await open();
        const query = prunableNotesQuery(test.ctx, ["a", "b"], test.clock.now(), true).compile();
        const plan = await test.ctx.db.executeQuery<{ detail: string }>(
            CompiledQuery.raw(`explain query plan ${query.sql}`, [...query.parameters]),
        );
        const details = plan.rows.map((row) => row.detail);

        assertEquals(details.filter((detail) => /^SCAN \w+( AS \w+)?$/.test(detail)), []);
    },
});
