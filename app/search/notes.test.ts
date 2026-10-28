import { assertEquals } from "@std/assert";
import { sql } from "kysely";
import { updateProfile } from "../accounts/profile.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { usesSqlite } from "../db/columns.ts";
import { share } from "../interactions/shares.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { emit } from "../kernel/events.ts";
import { upload } from "../media/uploads.ts";
import type { NoteReceived } from "../notes/events.ts";
import { editNote, postNote } from "../notes/notes.ts";
import { removeNote } from "../notes/removal.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { indexUnindexed } from "./notes.ts";
import { unindexedAccountIds, unindexedNoteIds } from "./search_queries.ts";
import { searchStatuses } from "./statuses.ts";
import { searchWords } from "./words.ts";

const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    // So that alice finds bob's statuses.
    await updateProfile(test.ctx, "bob", { indexable: true });

    const post = async (
        text: string,
        fields: { spoilerText?: string; mediaIds?: string[] } = {},
    ) => {
        const note = await postNote(test.ctx, "alice", {
            text,
            format: "text/plain",
            spoilerText: "",
            ...fields,
        });
        if (note === undefined) throw new Error("Not posted");
        return note.id;
    };

    /** The statuses alice finds with words starting with each of the words of `query`. */
    const find = async (query: string, limit = 40) => {
        const found = await searchStatuses(test.ctx, {
            query,
            viewerId: "alice",
            accountId: null,
            minId: null,
            maxId: null,
            limit,
            offset: 0,
        });
        return found.map((note) => note.id);
    };

    /** How many statuses' words are kept, counting those SQLite keeps apart. */
    const kept = async () => {
        const table = usesSqlite(test.ctx.db) ? sql`note_search_text` : sql`note_search`;
        const { rows: [row] } = await sql<{ count: number }>`SELECT count(*) AS count FROM ${table}`
            .execute(test.ctx.db);
        return Number(row.count);
    };

    return { ...test, post, find, kept };
};

Deno.test("words are runs of letters and digits, in lower case and without accents", () => {
    assertEquals(searchWords(`Café "naïve" -NOT* x:y_z 2026! 한국어 🦊`), [
        "cafe",
        "naive",
        "not",
        "x",
        "y",
        "z",
        "2026",
        "한국어",
    ]);
    assertEquals(searchWords(`"*" -- ()`), []);
});

Deno.test("a status is found by the start of words of its content warning, text and media descriptions", async () => {
    await using test = await open();
    const file = await upload(test.ctx, "alice", {
        file: new Blob([new Uint8Array([1, 2, 3])]),
        mediaType: "application/octet-stream",
        description: "A zipped archive",
    });
    await drain(test.ctx, queues);
    const id = await test.post("Hello <b>Verso</b> & Café friends", {
        spoilerText: "Spoilers",
        mediaIds: [file.id],
    });
    const other = await test.post("Goodbye");

    for (const query of ["hello", "VERSO", "verso hello", "cafe", "caf", "spoil", "zipped"]) {
        assertEquals(await test.find(query), [id], query);
    }
    for (const query of ["hello goodbye", "amp", "erso", "riends", ""]) {
        assertEquals(await test.find(query), [], query);
    }
    assertEquals(await test.find("goodbye"), [other]);
});

Deno.test("an edited status is found by its new words, and a deleted one not at all", async () => {
    await using test = await open();
    const id = await test.post("Before");
    await test.post("Kept");
    await share(test.ctx, "bob", id);

    await editNote(test.ctx, "alice", id, { text: "After" });
    assertEquals(await test.find("before"), []);
    assertEquals(await test.find("after"), [id]);
    // Boosts have no words of their own.
    assertEquals(await test.kept(), 2);

    await removeNote(test.ctx, id);
    assertEquals(await test.find("after"), []);
    assertEquals(await test.kept(), 1);
});

Deno.test("a remote status is indexed as it is received", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "bob", { content_html: "<p>From afar</p>" });
    assertEquals(await test.find("afar"), []);

    const received: NoteReceived = {
        type: "notes.received",
        noteId: note.id,
        edited: false,
        fetched: true,
    };
    await test.ctx.transaction((tx) => emit(tx, received));
    assertEquals(await test.find("afar"), [note.id]);
});

Deno.test("statuses from before search are indexed once", async () => {
    await using test = await open();
    const ids = [];
    for (let i = 0; i < 3; i++) {
        ids.push((await createNote(test.ctx, "alice", { content_html: `<p>Old ${i}</p>` })).id);
    }
    await createShare(test.ctx, "bob", ids[0]);
    await test.post("New");

    // Not the boost, nor the status indexed as it was posted.
    assertEquals(await indexUnindexed(test.ctx), 3);
    assertEquals(await indexUnindexed(test.ctx), 0);
    assertEquals(await test.find("old"), ids.toReversed());
    assertEquals(await test.find("old 1"), [ids[1]]);
    assertEquals(await test.find("old", 2), [ids[2], ids[1]]);
});

Deno.test("what isn't indexed is found a batch at a time, in id order, after the last batch", async () => {
    await using test = await open();
    const ids = [];
    for (let i = 0; i < 3; i++) {
        ids.push((await createNote(test.ctx, "alice", { content_html: `<p>Old ${i}</p>` })).id);
    }
    // Neither indexed nor counted.
    await createShare(test.ctx, "bob", ids[1]);

    assertEquals(await unindexedNoteIds(test.ctx, null, 2), ids.slice(0, 2));
    assertEquals(await unindexedNoteIds(test.ctx, ids[1], 2), [ids[2]]);
    assertEquals(await unindexedNoteIds(test.ctx, ids[2], 2), []);

    // Accounts as statuses, with bob's index, made as his profile changed, gone.
    await test.ctx.db.deleteFrom("account_search").execute();
    assertEquals(await unindexedAccountIds(test.ctx, null, 1), ["alice"]);
    assertEquals(await unindexedAccountIds(test.ctx, "alice", 5), ["bob"]);
    assertEquals(await unindexedAccountIds(test.ctx, "bob", 5), []);
});
