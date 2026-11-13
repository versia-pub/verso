import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { sanitizerVersion } from "../kernel/html.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { keepVersion } from "../notes/note_queries.ts";
import { createNote } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { startResanitising } from "./resanitising.ts";

const unsafe = '<p onclick="x">Hi</p><script>bad()</script>';
const safe = "<p>Hi</p>";

const field = {
    name: "Site",
    value: "Hi",
    format: "text/plain" as const,
    name_html: unsafe,
    value_html: unsafe,
};

/** Gives an account HTML as stored by `version`, or as received if 0. */
const setProfile = (ctx: Context, id: string, version: number) =>
    ctx.db.updateTable("accounts")
        .set({ note_html: unsafe, fields: [field], html_version: version })
        .where("id", "=", id)
        .execute();

const profileOf = async (ctx: Context, id: string) => {
    const row = await ctx.db.selectFrom("accounts")
        .select(["note_html", "fields", "html_version"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();

    return [row.note_html, row.fields[0].name_html, row.fields[0].value_html, row.html_version];
};

const contentOf = async (
    ctx: Context,
    table: "notes" | "note_versions",
    column: string,
    id: string,
) => {
    const row = await ctx.db.selectFrom(table)
        .select(["content_html", "html_version"])
        .where(column as "note_id", "=", id)
        .executeTakeFirstOrThrow();
    return [row.content_html, row.html_version];
};

Deno.test("remote HTML stored before this sanitiser is sanitised in place, once", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    const alice = await createLocalAccount(test.ctx, "alice");
    const carol = await createRemoteAccount(test.ctx, "carol", "b.example");
    const dave = await createRemoteAccount(test.ctx, "dave", "b.example");
    await setProfile(test.ctx, alice, 0);
    await setProfile(test.ctx, carol, 0);
    await setProfile(test.ctx, dave, sanitizerVersion);

    const remote = await createNote(test.ctx, carol, {
        instance_id: "b.example",
        remote_id: "c1",
        content_html: unsafe,
    });
    await keepVersion(test.ctx, remote);
    const local = await createNote(test.ctx, alice, { content_html: unsafe });
    await keepVersion(test.ctx, local);
    const current = await createNote(test.ctx, dave, {
        instance_id: "b.example",
        remote_id: "d1",
        content_html: unsafe,
        html_version: sanitizerVersion,
    });
    // More than one job sanitises.
    const many = Array.from({ length: 501 }, (_, i) => `many${String(i).padStart(3, "0")}`);
    await test.ctx.db.insertInto("notes")
        .values(many.map((id) => ({
            id,
            account_id: carol,
            instance_id: "b.example",
            remote_id: id,
            visibility: "public" as const,
            content: "",
            content_format: "text/plain" as const,
            content_html: unsafe,
            language: null,
            in_reply_to_id: null,
            in_reply_to_account_id: null,
            thread_id: id,
            quote_id: null,
            reblog_of_id: null,
            fetched_at: null,
            created_at: test.clock.now(),
            edited_at: null,
        })))
        .execute();

    await startResanitising(test.ctx);
    await drain(test.ctx, queues);

    assertEquals(await profileOf(test.ctx, carol), [safe, safe, safe, sanitizerVersion]);
    assertEquals(await profileOf(test.ctx, alice), [unsafe, unsafe, unsafe, 0]);
    assertEquals(await profileOf(test.ctx, dave), [unsafe, unsafe, unsafe, sanitizerVersion]);
    assertEquals(await contentOf(test.ctx, "notes", "id", remote.id), [safe, sanitizerVersion]);
    assertEquals(await contentOf(test.ctx, "note_versions", "note_id", remote.id), [
        safe,
        sanitizerVersion,
    ]);
    assertEquals(await contentOf(test.ctx, "notes", "id", local.id), [unsafe, 0]);
    assertEquals(await contentOf(test.ctx, "note_versions", "note_id", local.id), [unsafe, 0]);
    assertEquals(await contentOf(test.ctx, "notes", "id", current.id), [unsafe, sanitizerVersion]);

    const stale = await test.ctx.db.selectFrom("notes")
        .select("id")
        .where("instance_id", "is not", null)
        .where("html_version", "!=", sanitizerVersion)
        .execute();
    assertEquals(stale, []);

    // Each version's work is done once.
    await setProfile(test.ctx, carol, 0);
    await startResanitising(test.ctx);
    await drain(test.ctx, queues);
    assertEquals(await profileOf(test.ctx, carol), [unsafe, unsafe, unsafe, 0]);
});
