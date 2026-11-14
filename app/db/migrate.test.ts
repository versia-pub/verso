import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { type Kysely, sql } from "kysely";
import { firstIdAt } from "../kernel/ids.ts";
import { checkForeignKeys } from "./columns.ts";
import type { Database } from "./database.ts";
import { firstMigratedAt, migrate } from "./migrate.ts";
import { migrations } from "./migrations/mod.ts";
import { testDatabase, testDatabaseKind } from "./testing.ts";

const createNotes = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("notes")
            .addColumn("id", "integer", (column) => column.primaryKey())
            .execute();
    },
};

const addText = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("notes").addColumn("text", "text").execute();
    },
};

const failing = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("half_done").addColumn("id", "integer")
            .execute();

        await sql`not sql`.execute(db);
    },
};

const tables = async (db: Kysely<unknown>) =>
    (await db.introspection.getTables())
        .map((table) => table.name)
        .filter((name) => !name.startsWith("kysely_"))
        .toSorted();

Deno.test("migrations run in name order, once each", async () => {
    await using db = await testDatabase();

    assertEquals(
        await migrate(db, {
            "0002_add_text": addText,
            "0001_notes": createNotes,
        }),
        { ok: true, applied: ["0001_notes", "0002_add_text"] },
    );

    assertEquals(
        await migrate(db, {
            "0001_notes": createNotes,
            "0002_add_text": addText,
        }),
        { ok: true, applied: [] },
    );

    assertEquals(await tables(db), ["notes"]);
});

Deno.test("if one migration fails, none are applied", async () => {
    await using db = await testDatabase();

    const result = await migrate(db, {
        "0001_notes": createNotes,
        "0002_failing": failing,
        "0003_add_text": addText,
    });

    assertEquals(result.ok, false);
    assertEquals(await tables(db), []);

    assertEquals(await migrate(db, { "0001_notes": createNotes }), {
        ok: true,
        applied: ["0001_notes"],
    });
});

Deno.test("Verso's own migrations apply cleanly", async () => {
    await using db = await testDatabase();

    assertEquals((await migrate(db)).ok, true);
});

/** A parent table with a child whose rows are deleted with their parent. */
const createFamily = {
    up: async (db: Kysely<unknown>) => {
        await sql`create table parents (id text primary key)`.execute(db);
        await sql`create table children (
            id text primary key,
            parent_id text not null references parents (id) on delete cascade
        )`.execute(db);
        await sql`insert into parents values ('p')`.execute(db);
        await sql`insert into children values ('c', 'p')`.execute(db);
    },
};

/** Rebuilds `parents` the way SQLite changes a table, copying the rows that `copy` selects. */
const rebuildParents = (copy: string) => ({
    up: async (db: Kysely<unknown>) => {
        await sql`create table parents_new (id text primary key, name text)`.execute(db);
        await sql.raw(`insert into parents_new (id) select id from parents ${copy}`).execute(db);
        await sql`drop table parents`.execute(db);
        await sql`alter table parents_new rename to parents`.execute(db);
        await checkForeignKeys(db);
    },
});

const notSqlite = testDatabaseKind !== "sqlite";

Deno.test({
    name: "rebuilding a table on SQLite keeps the rows that refer to it",
    ignore: notSqlite,
    fn: async () => {
        await using db = await testDatabase();
        await migrate(db, { "0001_family": createFamily });

        const result = await migrate(db, {
            "0001_family": createFamily,
            "0002_rebuild": rebuildParents(""),
        });
        const children = await sql`select id from children`.execute(db);
        const { rows: [pragma] } = await sql`PRAGMA foreign_keys`.execute(db);

        assertEquals(result, { ok: true, applied: ["0002_rebuild"] });
        assertEquals(children.rows, [{ id: "c" }]);
        assertEquals(pragma, { foreign_keys: 1 });
    },
});

Deno.test({
    name: "a rebuild on SQLite that loses a referenced row fails, and changes nothing",
    ignore: notSqlite,
    fn: async () => {
        await using db = await testDatabase();
        await migrate(db, { "0001_family": createFamily });

        const result = await migrate(db, {
            "0001_family": createFamily,
            "0002_rebuild": rebuildParents("where false"),
        });
        const parents = await sql`select * from parents`.execute(db);

        assertEquals(result.ok, false);
        assertEquals(parents.rows, [{ id: "p" }]);
    },
});

Deno.test("the database was set up when its first migration ran", async () => {
    await using db = await testDatabase();

    await assertRejects(
        () => firstMigratedAt(db, { "1_notes": createNotes }),
        Error,
        "The database isn't set up",
    );

    const before = Date.now();
    await migrate(db, { "1_notes": createNotes });
    const after = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await migrate(db, { "1_notes": createNotes, "2_text": addText });

    const setUp = (await firstMigratedAt(db, { "1_notes": createNotes, "2_text": addText }))
        .getTime();
    assert(before <= setUp && setUp <= after, `${before} <= ${setUp} <= ${after}`);
});

Deno.test("existing statuses are put in the thread of the status they reply to", async () => {
    await using db = await testDatabase<Database>();
    const before = Object.fromEntries(
        Object.entries(migrations).filter(([name]) => name < "0060_thread_mutes"),
    );
    assertEquals((await migrate(db, before)).ok, true);

    const now = new Date("2026-01-01T00:00:00Z");
    await db.insertInto("accounts")
        .values({
            id: "alice",
            username: "alice",
            instance_id: null,
            remote_id: null,
            created_at: now,
        })
        .execute();

    // A status, a reply to it and a reply to that, and another status.
    for (const [id, parent] of [["a", null], ["b", "a"], ["c", "b"], ["d", null]]) {
        await sql`
            insert into notes
                (id, account_id, visibility, content, content_format, content_html,
                    in_reply_to_id, created_at)
            values (${id}, 'alice', 'public', 'Hi', 'text/plain', '<p>Hi</p>', ${parent}, ${now})
        `.execute(db);
    }

    assertEquals((await migrate(db)).ok, true);

    const rows = await db.selectFrom("notes").select(["id", "thread_id"]).orderBy("id").execute();
    assertEquals(rows, [
        { id: "a", thread_id: "a" },
        { id: "b", thread_id: "a" },
        { id: "c", thread_id: "a" },
        { id: "d", thread_id: "d" },
    ]);
});

Deno.test("the hashtags statuses used become known, and statuses' hashtags refer to them", async () => {
    await using db = await testDatabase<Database>();
    const before = Object.fromEntries(
        Object.entries(migrations).filter(([name]) => name < "0062_tags"),
    );
    assertEquals((await migrate(db, before)).ok, true);

    const now = new Date("2026-01-01T00:00:00Z");
    await db.insertInto("accounts")
        .values({
            id: "alice",
            username: "alice",
            instance_id: null,
            remote_id: null,
            created_at: now,
        })
        .execute();

    for (const [id, tags] of [["a", ["verso", "deno"]], ["b", ["verso"]]] as const) {
        await sql`
            insert into notes
                (id, account_id, visibility, content, content_format, content_html, created_at,
                    thread_id)
            values (${id}, 'alice', 'public', 'Hi', 'text/plain', '<p>Hi</p>', ${now}, ${id})
        `.execute(db);
        for (const name of tags) {
            await sql`insert into note_tags (note_id, name) values (${id}, ${name})`.execute(db);
        }
    }

    assertEquals((await migrate(db)).ok, true);

    assertEquals(await db.selectFrom("tags").selectAll().orderBy("name").execute(), [
        { name: "deno", display_name: "deno", trendable: null },
        { name: "verso", display_name: "verso", trendable: null },
    ]);
    assertEquals((await db.selectFrom("note_tags").selectAll().execute()).length, 3);
    await assertRejects(() =>
        db.insertInto("note_tags").values({ note_id: "a", name: "unknown" }).execute()
    );
});

Deno.test("push subscriptions there were keep being pushed to in aes128gcm", async () => {
    await using db = await testDatabase<Database>();
    const before = Object.fromEntries(
        Object.entries(migrations).filter(([name]) => name < "0097_standard_pushes"),
    );
    assertEquals((await migrate(db, before)).ok, true);

    const now = new Date("2026-01-01T00:00:00Z");
    await db.insertInto("accounts")
        .values({
            id: "alice",
            username: "alice",
            instance_id: null,
            remote_id: null,
            created_at: now,
        })
        .execute();
    await db.insertInto("apps")
        .values({
            id: "app",
            name: "App",
            website: null,
            redirect_uris: [],
            scopes: ["push"],
            client_id: "client",
            client_secret_hash: "hash",
            created_at: now,
        })
        .execute();
    await db.insertInto("access_tokens")
        .values({
            id: "token",
            token_hash: "hash",
            app_id: "app",
            account_id: "alice",
            scopes: ["push"],
            created_at: now,
        })
        .execute();
    await db.insertInto("push_subscriptions")
        // As the table was, without `standard`.
        .values({
            id: "subscription",
            token_id: "token",
            account_id: "alice",
            access_token: "secret",
            endpoint: "https://push.example/a",
            p256dh: "key",
            auth: "auth",
            alerts: [],
            policy: "all",
            created_at: now,
        } as never)
        .execute();

    assertEquals((await migrate(db)).ok, true);

    const { standard } = await db.selectFrom("push_subscriptions").select("standard")
        .executeTakeFirstOrThrow();
    assertEquals(standard, true);

    await assertRejects(() =>
        db.updateTable("push_subscriptions").set({ standard: null as never }).execute()
    );
});

Deno.test("apps there were keep their tokens once apps may have no secret", async () => {
    await using db = await testDatabase<Database>();
    const before = Object.fromEntries(
        Object.entries(migrations).filter(([name]) => name < "0101_public_apps"),
    );
    assertEquals((await migrate(db, before)).ok, true);

    const now = new Date("2026-01-01T00:00:00Z");
    const app = {
        id: "app",
        name: "App",
        website: null,
        redirect_uris: ["https://app.example/callback"],
        scopes: ["read" as const],
        client_id: "client",
        client_secret_hash: "hash",
        created_at: now,
    };
    await db.insertInto("apps").values(app).execute();
    await db.insertInto("access_tokens")
        .values({
            id: "token",
            token_hash: "hash",
            app_id: "app",
            account_id: null,
            scopes: ["read"],
            created_at: now,
        })
        .execute();

    assertEquals((await migrate(db)).ok, true);

    assertEquals(await db.selectFrom("apps").selectAll().execute(), [app]);
    assertEquals(
        (await db.selectFrom("access_tokens").select("app_id").executeTakeFirstOrThrow()).app_id,
        "app",
    );

    await db.insertInto("apps")
        .values({ ...app, id: "public", client_id: "public", client_secret_hash: null })
        .execute();
    await assertRejects(() =>
        db.insertInto("apps").values({ ...app, id: "same", client_secret_hash: null }).execute()
    );
    await db.deleteFrom("apps").where("id", "=", "app").execute();
    assertEquals(await db.selectFrom("access_tokens").selectAll().execute(), []);
});

Deno.test("domain blocks there were get ids in the order they were made", async () => {
    await using db = await testDatabase<Database>();
    const before = Object.fromEntries(
        Object.entries(migrations).filter(([name]) => name < "0103_domain_block_ids"),
    );
    assertEquals((await migrate(db, before)).ok, true);

    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-02-01T00:00:00Z");
    await (db as unknown as Kysely<{
        domain_blocks: { domain: string; reason: string; created_at: Date };
    }>).insertInto("domain_blocks")
        .values([
            { domain: "a.example", reason: "Spam", created_at: newer },
            { domain: "b.example", reason: "", created_at: older },
        ])
        .execute();

    assertEquals((await migrate(db)).ok, true);

    const blocks = await db.selectFrom("domain_blocks").selectAll().orderBy("id").execute();
    assertEquals(
        blocks.map(({ id: _, ...block }) => block),
        [
            {
                domain: "b.example",
                reason: "",
                private_comment: null,
                obfuscate: false,
                created_at: older,
            },
            {
                domain: "a.example",
                reason: "Spam",
                private_comment: null,
                obfuscate: false,
                created_at: newer,
            },
        ],
    );
    assertEquals(new Set(blocks.map((block) => block.id)).size, 2);

    for (const block of blocks) {
        const at = block.created_at.getTime();
        assert(block.id >= firstIdAt(new Date(at)) && block.id < firstIdAt(new Date(at + 1)));
    }

    await assertRejects(() =>
        db.insertInto("domain_blocks")
            .values({ id: "other", domain: "a.example", reason: "", created_at: newer })
            .execute()
    );
});

Deno.test("ids that were UUIDv7 become 18 characters, in every table that holds them", async () => {
    await using db = await testDatabase<Database>();
    const before = Object.fromEntries(
        Object.entries(migrations).filter(([name]) => name < "0105_versia_ids"),
    );
    assertEquals((await migrate(db, before)).ok, true);

    const created = new Date("2026-01-01T00:00:00Z");
    const raw = db as unknown as Kysely<{
        accounts: {
            id: string;
            username: string;
            remote_id: string | null;
            previous_id: string | null;
            created_at: Date;
        };
        notes: {
            id: string;
            account_id: string;
            in_reply_to_id: string | null;
            thread_id: string;
            visibility: string;
            content: string;
            content_format: string;
            content_html: string;
            created_at: Date;
        };
        bookmarks: { id: string; account_id: string; note_id: string; created_at: Date };
        markers: {
            account_id: string;
            timeline: string;
            last_read_id: string;
            version: number;
            updated_at: Date;
        };
        jobs: {
            id: string;
            queue: string;
            payload: string;
            dedupe_key: string;
            run_at: Date;
            attempts: number;
            max_attempts: number;
            created_at: Date;
        };
        roles: {
            id: string;
            name: string;
            permissions: string;
            created_at: Date;
        };
    }>;

    // The id and time of RFC 9562's example UUIDv7, so the new id is known.
    const vector = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f";
    const account = "018f0000-0000-7000-8000-000000000001";
    const note = "018f0000-0001-7000-8000-000000000002";
    const reply = "018f0000-0002-7000-8000-000000000003";
    const bookmark = "018f0000-0003-7000-8000-000000000004";
    const foreign = "018f1111-1111-7111-9111-111111111111";

    await raw.insertInto("accounts").values([
        { id: account, username: "a", remote_id: null, previous_id: null, created_at: created },
        {
            id: "remote",
            username: "b",
            remote_id: vector,
            previous_id: foreign,
            created_at: created,
        },
        {
            id: "other",
            username: "c",
            remote_id: "https://remote.example/users/c",
            previous_id: null,
            created_at: created,
        },
    ]).execute();
    await raw.insertInto("notes").values([
        {
            id: note,
            account_id: account,
            in_reply_to_id: null,
            thread_id: note,
            visibility: "public",
            content: "Hi",
            content_format: "text/plain",
            content_html:
                `<a href="https://verso.example/notes/${note}">a</a> <a href="https://other.example/notes/${foreign}">b</a>`,
            created_at: created,
        },
        {
            id: reply,
            account_id: account,
            in_reply_to_id: note,
            thread_id: note,
            visibility: "public",
            content: "Hello",
            content_format: "text/plain",
            content_html: "",
            created_at: created,
        },
    ]).execute();
    await raw.insertInto("bookmarks")
        .values({ id: bookmark, account_id: account, note_id: reply, created_at: created })
        .execute();
    await raw.insertInto("markers")
        .values({
            account_id: account,
            timeline: "home",
            last_read_id: note,
            version: 1,
            updated_at: created,
        })
        .execute();
    await raw.insertInto("jobs")
        .values({
            id: "job",
            queue: "q",
            payload: JSON.stringify({ note, other: foreign, list: [reply] }),
            dedupe_key: `deliver:${note}:${foreign}`,
            run_at: created,
            attempts: 0,
            max_attempts: 5,
            created_at: created,
        })
        .execute();
    await raw.insertInto("roles")
        .values({ id: "moderator", name: "Moderator", permissions: "[]", created_at: created })
        .execute();

    assertEquals((await migrate(db)).ok, true);

    const idFormat = /^[0-9a-hjkmnp-tv-z]{18}$/;
    const accounts = await db.selectFrom("accounts").selectAll().execute();
    const [newAccount] = accounts.filter((row) => row.username === "a");
    const notes = await db.selectFrom("notes").selectAll().orderBy("created_at").orderBy("id")
        .execute();
    const [newNote, newReply] = notes;
    const [newBookmark] = await db.selectFrom("bookmarks").selectAll().execute();

    for (const id of [newAccount.id, newNote.id, newReply.id, newBookmark.id]) {
        assertMatch(id, idFormat);
    }
    assertEquals(newReply.in_reply_to_id, newNote.id);
    assertEquals(newReply.account_id, newAccount.id);
    assertEquals(newBookmark.account_id, newAccount.id);
    assertEquals(newBookmark.note_id, newReply.id);
    assertEquals(newNote.thread_id, newNote.id);
    assertEquals(newReply.thread_id, newNote.id);

    // Each id keeps the millisecond of the UUIDv7 it came from.
    for (
        const [id, uuid] of [
            [newAccount.id, account],
            [newNote.id, note],
            [newReply.id, reply],
            [newBookmark.id, bookmark],
        ]
    ) {
        const at = parseInt(uuid.replaceAll("-", "").slice(0, 12), 16);
        assert(id >= firstIdAt(new Date(at)) && id < firstIdAt(new Date(at + 1)));
    }

    // Ids in longer values are rewritten when they are local, and left alone when they aren't.
    assertEquals(
        newNote.content_html,
        `<a href="https://verso.example/notes/${newNote.id}">a</a> <a href="https://other.example/notes/${foreign}">b</a>`,
    );
    const marker = await db.selectFrom("markers").selectAll().executeTakeFirstOrThrow();
    assertEquals(marker.last_read_id, newNote.id);
    assertEquals(marker.account_id, newAccount.id);

    const job = await db.selectFrom("jobs").selectAll().executeTakeFirstOrThrow();
    assertEquals(job.payload, { note: newNote.id, other: foreign, list: [newReply.id] });
    assertEquals(job.dedupe_key, `deliver:${newNote.id}:${foreign}`);

    // Remote ids come from the UUIDv7 alone. Ids that aren't a UUIDv7 stay as they are.
    const remote = accounts.find((row) => row.username === "b");
    assertEquals(remote?.id, "remote");
    assertEquals(remote?.remote_id, "bz4bh7kc6c6rrke0r3");
    assertMatch(remote?.previous_id ?? "", idFormat);
    assertEquals(
        accounts.find((row) => row.username === "c")?.remote_id,
        "https://remote.example/users/c",
    );
    assertEquals((await db.selectFrom("roles").select("id").execute()).map((row) => row.id), [
        "moderator",
    ]);

    await checkForeignKeys(db);
});

Deno.test("the UUIDv7 of RFC 9562 becomes a known id", async () => {
    await using db = await testDatabase<Database>();
    const before = Object.fromEntries(
        Object.entries(migrations).filter(([name]) => name < "0105_versia_ids"),
    );
    assertEquals((await migrate(db, before)).ok, true);

    await (db as unknown as Kysely<{
        accounts: { id: string; username: string; created_at: Date };
    }>).insertInto("accounts")
        .values({
            id: "017f22e2-79b0-7cc3-98c4-dc0c0c07398f",
            username: "a",
            created_at: new Date(),
        })
        .execute();

    assertEquals((await migrate(db)).ok, true);

    const accounts = await db.selectFrom("accounts").select("id").execute();
    assertEquals(accounts.map((row) => row.id), ["bz4bh7kc6c6rrke0r3"]);
});

Deno.test("ids that differ only after the bits an id keeps stay different", async () => {
    await using db = await testDatabase<Database>();
    const before = Object.fromEntries(
        Object.entries(migrations).filter(([name]) => name < "0105_versia_ids"),
    );
    assertEquals((await migrate(db, before)).ok, true);

    // The bits these keep end in 24 ones, so a moved id's counter wraps to 0.
    const first = "018f0000-0000-7abc-bfff-fffffffffff1";
    const second = "018f0000-0000-7abc-bfff-fffffffffff2";
    const third = "018f0000-0000-7abc-bfff-fffffffffff3";
    const old = db as unknown as Kysely<{
        accounts: { id: string; username: string; created_at: Date };
        blocks: { id: string; account_id: string; target_id: string; created_at: Date };
    }>;
    await old.insertInto("accounts")
        .values([
            { id: third, username: "third", created_at: new Date() },
            { id: second, username: "second", created_at: new Date() },
            { id: first, username: "first", created_at: new Date() },
        ])
        .execute();
    await old.insertInto("blocks")
        .values({
            id: "018f0000-0000-7000-8000-000000000001",
            account_id: first,
            target_id: second,
            created_at: new Date(),
        })
        .execute();

    assertEquals((await migrate(db)).ok, true);

    // The smallest UUID keeps its id, and each later one takes the next free counter.
    const accounts = await db.selectFrom("accounts").select(["id", "username"]).orderBy("id")
        .execute();
    assertEquals(accounts, [
        { id: "cf0000005bszzg0000", username: "second" },
        { id: "cf0000005bszzg0001", username: "third" },
        { id: "cf0000005bszzzzzzz", username: "first" },
    ]);

    const blocks = await db.selectFrom("blocks").select(["account_id", "target_id"]).execute();
    assertEquals(blocks, [{ account_id: "cf0000005bszzzzzzz", target_id: "cf0000005bszzg0000" }]);
});

Deno.test("only whole UUIDv7 become ids, and only those dated before 2109", async () => {
    await using db = await testDatabase<Database>();
    const before = Object.fromEntries(
        Object.entries(migrations).filter(([name]) => name < "0105_versia_ids"),
    );
    assertEquals((await migrate(db, before)).ok, true);

    const old = db as unknown as Kysely<{
        accounts: { id: string; username: string; remote_id: string | null; created_at: Date };
    }>;
    const badVariant = "018f0000-0000-7abc-cdef-0123456789a1";
    const longer = "018f0000-0000-7abc-8def-0123456789a1/old";
    await old.insertInto("accounts")
        .values([
            { id: badVariant, username: "a", remote_id: null, created_at: new Date() },
            { id: "b", username: "b", remote_id: longer, created_at: new Date() },
            {
                id: "04000000-0000-7000-8000-000000000000",
                username: "late",
                remote_id: null,
                created_at: new Date(),
            },
        ])
        .execute();

    assertEquals((await migrate(db)).ok, false);

    // The last millisecond that fits works.
    await old.updateTable("accounts")
        .set({ id: "03ffffff-ffff-7000-8000-000000000000" })
        .where("username", "=", "late")
        .execute();
    assertEquals((await migrate(db)).ok, true);

    const accounts = await db.selectFrom("accounts").select(["id", "remote_id"]).orderBy("username")
        .execute();
    assertEquals(accounts, [
        { id: badVariant, remote_id: null },
        { id: "b", remote_id: longer },
        { id: "zzzzzzzzr000000000", remote_id: null },
    ]);
});

Deno.test("foreign keys are not deferrable once the migrations have run", async () => {
    await using db = await testDatabase<Database>();
    assertEquals((await migrate(db)).ok, true);

    if (testDatabaseKind === "sqlite") return;

    const { rows } = await sql<{ total: number; deferrable: number }>`
        select count(*)::int as total, count(*) filter (where condeferrable)::int as deferrable
        from pg_constraint where contype = 'f'`.execute(db);

    assert(rows[0].total > 0);
    assertEquals(rows[0].deferrable, 0);
});
