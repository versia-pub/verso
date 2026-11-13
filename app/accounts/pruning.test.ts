import { assertEquals, assertStringIncludes } from "@std/assert";
import { CompiledQuery, sql } from "kysely";
import { testDatabaseKind } from "../db/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { dayMs } from "../kernel/clock.ts";
import type { Context } from "../kernel/context.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { createNote } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { pruneRemoteAccounts, startAccountPruning } from "./pruning.ts";
import {
    keepingColumns,
    oldRemoteAccountsQuery,
    prunableAccountsQuery,
} from "./pruning_queries.ts";
import { createLocalAccount, createRemoteAccount } from "./testing.ts";

/** alice here, and dave on b.example, who nothing refers to. */
const open = async (settings: { remoteStatusMs?: number | null } = {}) => {
    const test = await createTestContext({ settings });
    await createInstance(test.ctx, "b.example");
    await createLocalAccount(test.ctx, "alice");
    await createRemoteAccount(test.ctx, "dave", "b.example");

    return test;
};

/**
 * Prunes the accounts fetched before now, as the command does, and returns the remote ones left.
 */
const prune = async (ctx: Context) => {
    await pruneRemoteAccounts(ctx, new Date(ctx.clock.now().getTime() + 1));
    return await remoteAccountIds(ctx);
};

const remoteAccountIds = async (ctx: Context) =>
    (await ctx.db.selectFrom("accounts").select("id").where("instance_id", "is not", null)
        .orderBy("id").execute()).map((row) => row.id);

/** A status by alice, for dave to interact with. */
const aliceNote = async (ctx: Context) => (await createNote(ctx, "alice")).id;

/** What refers to dave, by the column it does so with. */
const references: Record<string, (ctx: Context) => Promise<unknown>> = {
    "account_notes.target_id": (ctx) =>
        ctx.db.insertInto("account_notes")
            .values({
                account_id: "alice",
                target_id: "dave",
                comment: "Met at a party",
                updated_at: ctx.clock.now(),
            })
            .execute(),
    "accounts.moved_to_account_id": (ctx) =>
        ctx.db.updateTable("accounts").set({ moved_to_account_id: "dave" })
            .where("id", "=", "alice")
            .execute(),
    "blocks.account_id": (ctx) => relate(ctx, "blocks", "dave", "alice"),
    "blocks.target_id": (ctx) => relate(ctx, "blocks", "alice", "dave"),
    "endorsements.target_id": (ctx) => relate(ctx, "endorsements", "alice", "dave"),
    "follows.followee_id": (ctx) => follow(ctx, "alice", "dave"),
    "follows.follower_id": (ctx) => follow(ctx, "dave", "alice"),
    "likes.account_id": async (ctx) => {
        const noteId = await aliceNote(ctx);
        await ctx.db.insertInto("likes")
            .values({
                id: ctx.ids(),
                account_id: "dave",
                note_id: noteId,
                instance_id: "b.example",
                created_at: ctx.clock.now(),
            })
            .execute();
    },
    "list_accounts.account_id": async (ctx) => {
        const listId = ctx.ids();
        await ctx.db.insertInto("lists")
            .values({
                id: listId,
                account_id: "alice",
                title: "Friends",
                replies_policy: "list",
                exclusive: false,
                created_at: ctx.clock.now(),
            })
            .execute();
        await ctx.db.insertInto("list_accounts")
            .values({
                id: ctx.ids(),
                list_id: listId,
                account_id: "dave",
                follow_id: null,
                created_at: ctx.clock.now(),
            })
            .execute();
    },
    "mutes.account_id": (ctx) => mute(ctx, "dave", "alice"),
    "mutes.target_id": (ctx) => mute(ctx, "alice", "dave"),
    "note_mentions.account_id": (ctx) => createNote(ctx, "alice", {}, ["dave"]),
    "notes.account_id": (ctx) => {
        const id = ctx.ids();
        return createNote(ctx, "dave", { id, instance_id: "b.example", remote_id: id });
    },
    "notes.in_reply_to_account_id": (ctx) =>
        createNote(ctx, "alice", { in_reply_to_account_id: "dave" }),
    "notification_permissions.from_account_id": (ctx) =>
        ctx.db.insertInto("notification_permissions")
            .values({
                account_id: "alice",
                from_account_id: "dave",
                created_at: ctx.clock.now(),
            })
            .execute(),
    "notification_requests.from_account_id": (ctx) =>
        ctx.db.insertInto("notification_requests")
            .values({
                id: ctx.ids(),
                account_id: "alice",
                from_account_id: "dave",
                notifications_count: 1,
                created_at: ctx.clock.now(),
                updated_at: ctx.clock.now(),
            })
            .execute(),
    "notifications.from_account_id": (ctx) =>
        ctx.db.insertInto("notifications")
            .values({
                id: ctx.ids(),
                account_id: "alice",
                type: "follow",
                from_account_id: "dave",
                created_at: ctx.clock.now(),
            })
            .execute(),
    "poll_votes.account_id": async (ctx) => {
        const noteId = await aliceNote(ctx);
        const pollId = ctx.ids();
        await ctx.db.insertInto("polls")
            .values({
                id: pollId,
                note_id: noteId,
                multiple: false,
                hide_totals: false,
                created_at: ctx.clock.now(),
            })
            .execute();
        await ctx.db.insertInto("poll_votes")
            .values({
                id: ctx.ids(),
                poll_id: pollId,
                account_id: "dave",
                choice: 0,
                created_at: ctx.clock.now(),
            })
            .execute();
    },
    "reactions.account_id": async (ctx) => {
        const noteId = await aliceNote(ctx);
        await ctx.db.insertInto("reactions")
            .values({
                id: ctx.ids(),
                account_id: "dave",
                note_id: noteId,
                text: "👍",
                instance_id: "b.example",
                created_at: ctx.clock.now(),
            })
            .execute();
    },
    "reports.account_id": (ctx) => report(ctx, "dave", "alice"),
    "reports.target_account_id": (ctx) => report(ctx, "alice", "dave"),
    "suggestion_dismissals.target_id": (ctx) =>
        ctx.db.insertInto("suggestion_dismissals")
            .values({ account_id: "alice", target_id: "dave", created_at: ctx.clock.now() })
            .execute(),
};

const relate = (
    ctx: Context,
    table: "blocks" | "endorsements",
    accountId: string,
    targetId: string,
) => ctx.db.insertInto(table)
    .values({
        id: ctx.ids(),
        account_id: accountId,
        target_id: targetId,
        created_at: ctx.clock.now(),
    })
    .execute();

const follow = (ctx: Context, followerId: string, followeeId: string) =>
    ctx.db.insertInto("follows")
        .values({
            id: ctx.ids(),
            follower_id: followerId,
            followee_id: followeeId,
            accepted: false,
            created_at: ctx.clock.now(),
        })
        .execute();

const mute = (ctx: Context, accountId: string, targetId: string) =>
    ctx.db.insertInto("mutes")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            target_id: targetId,
            notifications: true,
            created_at: ctx.clock.now(),
        })
        .execute();

const report = (ctx: Context, accountId: string, targetId: string) =>
    ctx.db.insertInto("reports")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            target_account_id: targetId,
            category: "other",
            comment: "",
            note_ids: [],
            forwarded: false,
            created_at: ctx.clock.now(),
        })
        .execute();

Deno.test("a remote account nothing refers to is pruned", async () => {
    await using test = await open();

    assertEquals(await prune(test.ctx), []);
});

for (const [column, refer] of Object.entries(references)) {
    Deno.test(`a remote account referred to by ${column} is kept`, async () => {
        await using test = await open();
        await refer(test.ctx);

        assertEquals(await prune(test.ctx), ["dave"]);
    });
}

for (
    const [name, change] of [
        ["suspended", { suspended_at: new Date(0) }],
        ["silenced", { silenced_at: new Date(0) }],
        ["a bot", { bot: true }],
    ] as const
) {
    Deno.test(`a remote account that is ${name} is kept, as on Mastodon`, async () => {
        await using test = await open();
        await test.ctx.db.updateTable("accounts").set(change).where("id", "=", "dave").execute();

        assertEquals(await prune(test.ctx), ["dave"]);
    });
}

Deno.test("a remote account fetched since the cutoff, and local accounts, are kept", async () => {
    await using test = await open();
    await createRemoteAccount(test.ctx, "erin", "b.example");
    await test.ctx.db.updateTable("accounts").set({ fetched_at: new Date(0) })
        .where("id", "=", "dave").execute();

    // Fetched at the cutoff, so not before it.
    assertEquals(await pruneRemoteAccounts(test.ctx, new Date(0)), 0);
    assertEquals(await pruneRemoteAccounts(test.ctx, new Date(1)), 1);
    assertEquals(await remoteAccountIds(test.ctx), ["erin"]);
    assertEquals(
        (await test.ctx.db.selectFrom("accounts").select("id").where("instance_id", "is", null)
            .execute()).map((row) => row.id),
        ["alice"],
    );
});

Deno.test("pruned accounts' pictures go with them", async () => {
    await using test = await open();
    await createRemoteAccount(test.ctx, "erin", "b.example");
    const picture = async (accountId: string, column: "avatar_id" | "header_id") => {
        const id = test.ctx.ids();
        await test.ctx.db.insertInto("media")
            .values({
                id,
                account_id: null,
                instance_id: "b.example",
                media_type: "image/png",
                url: `https://b.example/${id}.png`,
                created_at: test.clock.now(),
            })
            .execute();
        await test.ctx.db.updateTable("accounts").set({ [column]: id })
            .where("id", "=", accountId).execute();
    };
    await picture("dave", "avatar_id");
    await picture("dave", "header_id");
    await picture("erin", "header_id");

    assertEquals(await prune(test.ctx), []);
    assertEquals(await test.ctx.db.selectFrom("media").select("id").execute(), []);
});

/** Adds `count` remote accounts on b.example that nothing refers to, fetched before now. */
const addRemoteAccounts = async (ctx: Context, count: number) => {
    const fetchedAt = new Date(ctx.clock.now().getTime() - 2 * dayMs);
    for (let start = 0; start < count; start += 200) {
        await ctx.db.insertInto("accounts")
            .values(
                Array.from({ length: Math.min(200, count - start) }, (_, index) => {
                    const id = `x${String(start + index).padStart(5, "0")}`;
                    return {
                        id,
                        username: id,
                        instance_id: "b.example",
                        remote_id: id,
                        created_at: fetchedAt,
                        fetched_at: fetchedAt,
                    };
                }),
            )
            .execute();
    }
};

Deno.test("each day, remote accounts fetched more than remote_status_days ago are pruned, in batches", async () => {
    await using test = await open({ remoteStatusMs: dayMs });
    await addRemoteAccounts(test.ctx, 1200);

    await startAccountPruning(test.ctx);
    await drain(test.ctx, queues);

    // dave was fetched just now.
    assertEquals(await remoteAccountIds(test.ctx), ["dave"]);
});

Deno.test("remote accounts aren't pruned unless remote_status_days is set", async () => {
    await using test = await open();
    await addRemoteAccounts(test.ctx, 3);

    await startAccountPruning(test.ctx);
    await drain(test.ctx, queues);

    assertEquals((await remoteAccountIds(test.ctx)).length, 4);
});

Deno.test("old remote accounts are read by index", async () => {
    await using test = await open();
    const { db } = test.ctx;
    const old = oldRemoteAccountsQuery(test.ctx, test.clock.now(), {
        fetchedAt: test.clock.now(),
        id: "0",
    }, 500).compile();
    if (testDatabaseKind === "sqlite") {
        const plan = await db.executeQuery<{ detail: string }>(
            CompiledQuery.raw(`explain query plan ${old.sql}`, [...old.parameters]),
        );
        assertStringIncludes(
            plan.rows.map((row) => row.detail).join("\n"),
            "accounts_remote_by_fetch",
        );
        return;
    }

    await sql`set enable_seqscan = off`.execute(db);
    const plan = await db.executeQuery(
        CompiledQuery.raw(`explain (format json) ${old.sql}`, [...old.parameters]),
    );
    assertStringIncludes(JSON.stringify(plan.rows), '"Index Name":"accounts_remote_by_fetch"');
});

/**
 * The columns that refer to accounts but don't keep one: its own rows, deleted with it, or those
 * only a local account has. A new reference to accounts should be added here or to
 * {@link keepingColumns}, after deciding which.
 */
const ownColumns = [
    "access_tokens.account_id",
    "account_domain_blocks.account_id",
    "account_emojis.account_id",
    "account_notes.account_id",
    "account_roles.account_id",
    "account_search.account_id",
    "announcement_dismissals.account_id",
    "announcement_reactions.account_id",
    "bookmarks.account_id",
    "conversations.account_id",
    "emojis.account_id",
    "endorsements.account_id",
    "featured_tags.account_id",
    "filters.account_id",
    "identities.account_id",
    "lists.account_id",
    "markers.account_id",
    "media.account_id",
    "note_pins.account_id",
    "notification_permissions.account_id",
    "notification_policies.account_id",
    "notification_requests.account_id",
    "notifications.account_id",
    "oauth_flows.account_id",
    "push_subscriptions.account_id",
    "reports.resolved_by_account_id",
    "scheduled_notes.account_id",
    "suggestion_dismissals.account_id",
    "tag_follows.account_id",
    "thread_mutes.account_id",
    "trending_statuses.account_id",
    "web_preferences.account_id",
];

Deno.test({
    name: "every reference to accounts either keeps one or is its own, and what keeps is indexed",
    ignore: testDatabaseKind !== "sqlite",
    fn: async () => {
        await using test = await open();
        const rows = await sql<{ name: string; from: string; indexed: number }>`
            select m.name, p."from", exists (
                select 1 from pragma_index_list(m.name) l, pragma_index_info(l.name) i
                where l.partial = 0 and i.seqno = 0 and i.name = p."from"
            ) as indexed
            from sqlite_master m, pragma_foreign_key_list(m.name) p
            where m.type = 'table' and p."table" = 'accounts'
        `.execute(test.ctx.db);
        const keeping = keepingColumns.map(([table, column]) => `${table}.${column}`);

        assertEquals(
            rows.rows.map((row) => `${row.name}.${row.from}`).toSorted(),
            [...keeping, ...ownColumns].toSorted(),
        );
        // Otherwise each account looked at reads the whole table.
        assertEquals(
            rows.rows.filter((row) => keeping.includes(`${row.name}.${row.from}`) && !row.indexed)
                .map((row) => `${row.name}.${row.from}`),
            [],
        );
    },
});

Deno.test({
    name: "what keeps an account is looked up by index, not by reading every row",
    ignore: testDatabaseKind !== "sqlite",
    fn: async () => {
        await using test = await open();
        const query = prunableAccountsQuery(test.ctx, ["a", "b"]).compile();
        const plan = await test.ctx.db.executeQuery<{ detail: string }>(
            CompiledQuery.raw(`explain query plan ${query.sql}`, [...query.parameters]),
        );
        const details = plan.rows.map((row) => row.detail);

        assertEquals(details.filter((detail) => /^SCAN \w+( AS \w+)?$/.test(detail)), []);
    },
});
