import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { sql } from "kysely";
import { emptyAccount, findAccount } from "../accounts/account_queries.ts";
import { linkIdentity } from "../accounts/identity_queries.ts";
import { provision } from "../accounts/provision.ts";
import { createLocalAccount, createRemoteAccount, createRole } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { undoneReactionsQueue } from "../interactions/reactions.ts";
import { bytesSource } from "../kernel/files.ts";
import { testDatabaseKind } from "../db/testing.ts";
import { follow } from "../graph/follows.ts";
import { like } from "../interactions/likes.ts";
import type { Context } from "../kernel/context.ts";
import type { Issuer } from "../kernel/identity.ts";
import { upload } from "../media/uploads.ts";
import { findNote } from "../notes/note_queries.ts";
import { createNote } from "../notes/testing.ts";
import { fileReport } from "../reports/reports.ts";
import { FanOutJob, fanOutQueue } from "../federation/deliver.ts";
import { createTestContext } from "../testing/context.ts";
import { keptColumns, purgedColumns } from "./account_deletion_queries.ts";
import { deleteLocalAccount } from "./account_deletions.ts";
import { unsuspend } from "./suspensions.ts";

Deno.test({
    name: "every column referring to an account is either purged or kept when it is deleted",
    // SQLite lists foreign keys most simply.
    ignore: testDatabaseKind !== "sqlite",
    fn: async () => {
        await using test = await createTestContext();
        const tables = await sql<{ name: string }>`
            select name from sqlite_master where type = 'table'`.execute(test.ctx.db);
        const referring: string[] = [];

        for (const { name } of tables.rows) {
            const keys = await sql<{ table: string; from: string }>`
                select * from pragma_foreign_key_list(${name})`.execute(test.ctx.db);
            for (const key of keys.rows) {
                if (key.table === "accounts") referring.push(`${name}.${key.from}`);
            }
        }

        // Media and emojis are deleted on their own, so their files are too.
        const handled = [...purgedColumns, ...keptColumns, ["media", "account_id"], [
            "emojis",
            "account_id",
        ]].map(([table, column]) => `${table}.${column}`);

        assertEquals(referring.toSorted(), handled.toSorted());
    },
});

/** How many rows of `table` refer to alice in `column`. */
const rowsOf = async (ctx: Context, table: string, column = "account_id") =>
    Number(
        (await sql<{ n: number }>`select count(*) as n from ${sql.table(table)}
            where ${sql.ref(column)} = 'alice'`.execute(ctx.db)).rows[0].n,
    );

/** The Deletes of users queued for every instance, by the user they delete. */
const userDeletes = async (ctx: Context) => {
    const jobs = await ctx.db.selectFrom("jobs").select("payload")
        .where("queue", "=", fanOutQueue).execute();
    const bodies = await ctx.db.selectFrom("delivery_bodies").select(["id", "body"]).execute();
    const bodyOf = new Map(bodies.map((row) => [row.id, JSON.parse(row.body)]));

    return jobs.map((job) => FanOutJob.parse(job.payload)).map((job) => ({
        entity: bodyOf.get(job.bodyId),
        every: job.everyInstance,
    }))
        .filter(({ entity }) => entity?.type === "Delete" && entity.deleted_type === "User")
        .map(({ entity, every }) => [entity.author, entity.deleted, every]);
};

/** A file that isn't a picture, so it is stored as it is. */
const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

/** Bytes standing for a preview of the file. */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

/**
 * Gives alice a status, an upload, an emoji, a login and a follow, like and report with bob, and
 * returns bob's status and alice's upload.
 */
const fill = async (ctx: Context) => {
    for (const id of ["alice", "bob"]) await createLocalAccount(ctx, id);
    await createNote(ctx, "alice");
    const bobs = await createNote(ctx, "bob");
    await follow(ctx, "alice", "bob");
    await follow(ctx, "bob", "alice");
    await like(ctx, "alice", bobs.id);

    const file = await upload(ctx, "alice", {
        file: new Blob([zip]),
        mediaType: "application/zip",
    });
    const preview = await ctx.files.put(await bytesSource(png), "image/png");
    await ctx.db.updateTable("media").set({ preview_sha256: preview }).where("id", "=", file.id)
        .execute();

    await ctx.db.updateTable("accounts")
        .set({
            display_name: "Alice",
            note: "Hi",
            note_html: "<p>Hi</p>",
            fields: [{
                name: "Site",
                value: "alice.example",
                format: "text/plain",
                name_html: "Site",
                value_html: "alice.example",
            }],
            locked: true,
            bot: true,
            discoverable: true,
            trendable: true,
            indexable: true,
            attribution_domains: ["alice.example"],
            last_status_at: ctx.clock.now(),
        })
        .where("id", "=", "alice")
        .execute();

    await ctx.db.insertInto("emojis")
        .values({
            id: ctx.ids(),
            instance_id: null,
            account_id: "alice",
            shortcode: "mine",
            media_id: file.id,
            created_at: ctx.clock.now(),
        })
        .execute();
    const emoji = await ctx.db.selectFrom("emojis").select("id").where("account_id", "=", "alice")
        .executeTakeFirstOrThrow();

    await ctx.db.insertInto("reactions")
        .values({
            id: ctx.ids(),
            account_id: "bob",
            note_id: bobs.id,
            text: null,
            emoji_id: emoji.id,
            instance_id: null,
            remote_id: null,
            created_at: ctx.clock.now(),
        })
        .execute();

    await linkIdentity(ctx, { issuer: "https://id.example", subject: "1", accountId: "alice" });
    await fileReport(ctx, "bob", {
        targetId: "alice",
        noteIds: [],
        comment: "",
        ruleIds: [],
        forward: false,
    }, 0);

    // Everything is there to be deleted.
    const bob = await findAccount(ctx, "bob");
    assertEquals([bob?.followers_count, bob?.following_count], [1, 1]);
    assertEquals((await findNote(ctx, bobs.id))?.likes_count, 1);
    assertNotEquals(await ctx.files.get(file.sha256 ?? ""), undefined);
    assertNotEquals(await ctx.files.get(preview), undefined);
    assertEquals(await rowsOf(ctx, "emojis"), 1);

    return { bobs, file, preview };
};

Deno.test("a deleted account is kept empty and suspended, with its login and the reports about it", async () => {
    await using test = await createTestContext();
    const { bobs, file, preview } = await fill(test.ctx);
    const deletedAt = test.clock.now();

    assert(await deleteLocalAccount(test.ctx, "alice", { tombstone: true }));

    const alice = await findAccount(test.ctx, "alice");
    assertEquals(alice?.deleted_at, deletedAt);
    assertEquals(alice?.suspended_at, deletedAt);
    assertEquals(
        [
            alice?.display_name,
            alice?.note,
            alice?.note_html,
            alice?.fields,
            alice?.attribution_domains,
        ],
        ["", "", "", [], []],
    );
    assertEquals(
        [alice?.locked, alice?.bot, alice?.discoverable, alice?.trendable, alice?.indexable],
        [false, false, false, false, false],
    );
    assertEquals([alice?.avatar_id, alice?.header_id, alice?.last_status_at], [null, null, null]);
    assertEquals(
        [alice?.statuses_count, alice?.followers_count, alice?.following_count],
        [0, 0, 0],
    );

    const bob = await findAccount(test.ctx, "bob");
    assertEquals([bob?.followers_count, bob?.following_count], [0, 0]);
    assertEquals((await findNote(test.ctx, bobs.id))?.likes_count, 0);

    for (const table of ["notes", "likes", "media", "emojis"]) {
        assertEquals(await rowsOf(test.ctx, table), 0, table);
    }
    assertEquals(await rowsOf(test.ctx, "follows", "follower_id"), 0);
    assertEquals(await rowsOf(test.ctx, "follows", "followee_id"), 0);
    assertEquals(await test.ctx.files.get(file.sha256 ?? ""), undefined);
    assertEquals(await test.ctx.files.get(preview), undefined);

    // Bob's reaction with alice's emoji is undone, so other instances are told.
    const queues = await test.ctx.db.selectFrom("jobs").select("queue").execute();
    assertEquals(
        queues.filter((job) => job.queue === undoneReactionsQueue).length,
        1,
    );
    assertEquals(await rowsOf(test.ctx, "identities"), 1);
    assertEquals(await rowsOf(test.ctx, "reports", "target_account_id"), 1);
    assertEquals(await userDeletes(test.ctx), [["alice", "alice", true]]);

    // It stays suspended, and deleting it again later changes nothing.
    test.clock.advance(60_000);
    assertEquals(await unsuspend(test.ctx, "alice"), false);
    assertEquals(await deleteLocalAccount(test.ctx, "alice", { tombstone: true }), false);
    const again = await findAccount(test.ctx, "alice");
    assertEquals([again?.suspended_at, again?.deleted_at], [deletedAt, deletedAt]);
    assertEquals((await userDeletes(test.ctx)).length, 1);

    // Logging in again finds it, still empty, and without the roles the login's claims give.
    await createRole(test.ctx, "Admin", ["roles"]);
    const issuer: Issuer = {
        name: "ID",
        url: "https://id.example",
        username_claim: "preferred_username",
        registration: "open",
        roles: [{ claim: "groups", contains: "admins", role: "Admin" }],
    };

    const login = await provision(test.ctx, issuer, {
        sub: "1",
        preferred_username: "alice",
        name: "Alice",
        groups: ["admins"],
    });

    assertEquals(login, { ok: true, accountId: "alice", created: false });
    assertEquals((await findAccount(test.ctx, "alice"))?.display_name, "");
    assertEquals(await rowsOf(test.ctx, "account_roles"), 0);
});

Deno.test("an account deleted without a tombstone is removed, with its login and the reports about it", async () => {
    await using test = await createTestContext();
    const { bobs, file } = await fill(test.ctx);

    assert(await deleteLocalAccount(test.ctx, "alice", { tombstone: false }));

    assertEquals(await findAccount(test.ctx, "alice"), undefined);

    const bob = await findAccount(test.ctx, "bob");
    assertEquals([bob?.followers_count, bob?.following_count], [0, 0]);
    assertEquals((await findNote(test.ctx, bobs.id))?.likes_count, 0);
    assertEquals(await test.ctx.files.get(file.sha256 ?? ""), undefined);
    assertEquals(await rowsOf(test.ctx, "identities"), 0);
    assertEquals(await rowsOf(test.ctx, "reports", "target_account_id"), 0);
    assertEquals(await userDeletes(test.ctx), [["alice", "alice", true]]);

    // Its login can make a new account.
    await createLocalAccount(test.ctx, "alice");
    assert(
        await linkIdentity(test.ctx, {
            issuer: "https://id.example",
            subject: "1",
            accountId: "alice",
        }),
    );
});

Deno.test("a remote account isn't emptied as a deleted one", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    await test.ctx.db.updateTable("accounts").set({ display_name: "Carol" }).execute();

    assertEquals(await emptyAccount(test.ctx, "carol", test.clock.now()), false);
    const carol = await findAccount(test.ctx, "carol");
    assertEquals([carol?.display_name, carol?.deleted_at], ["Carol", null]);
});
