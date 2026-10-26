import { assertEquals } from "@std/assert";
import type { Insertable } from "kysely";
import { createLocalAccount } from "../accounts/testing.ts";
import { block } from "../graph/blocks.ts";
import { follow } from "../graph/follows.ts";
import { mute } from "../graph/mutes.ts";
import { createTestContext } from "../testing/context.ts";
import type { NoteRow } from "./note_queries.ts";
import type { NotesTable } from "./tables.ts";
import { createNote } from "./testing.ts";
import { threadOf } from "./threads.ts";

/** Alice, bob, who follows her, and dave, with statuses named by their position in a thread. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "dave"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "bob", "alice");
    const notes = new Map<string, NoteRow>();

    /**
     * Adds a status called `name` by `accountId`, replying to the status called `parent`, if any.
     */
    const add = async (
        name: string,
        accountId: string,
        parent?: string,
        note: Partial<Insertable<NotesTable>> = {},
    ) => {
        const replied = parent === undefined ? undefined : notes.get(parent);
        const row = await createNote(test.ctx, accountId, {
            in_reply_to_id: replied?.id ?? null,
            in_reply_to_account_id: replied?.account_id ?? null,
            ...note,
        });
        notes.set(name, row);

        return row;
    };

    /** The thread around `note` as `viewerId` sees it, by name. */
    const thread = async (note: NoteRow, viewerId: string | null = null) => {
        const { ancestors, descendants } = await threadOf(test.ctx, note, viewerId);
        const names = new Map([...notes].map(([name, row]) => [row.id, name]));
        const name = (row: NoteRow) => names.get(row.id) ?? row.id;

        return { ancestors: ancestors.map(name), descendants: descendants.map(name) };
    };

    return { ...test, add, thread };
};

Deno.test("a thread is what a note replies to, oldest first, and the replies under it, in order", async () => {
    await using test = await open();
    const root = await test.add("root", "alice");
    await test.add("parent", "bob", "root");
    const note = await test.add("note", "alice", "parent");
    await test.add("first", "bob", "note");
    await test.add("second", "dave", "note");
    await test.add("deep", "alice", "first");
    await test.add("aside", "bob", "root");

    assertEquals(await test.thread(note), {
        ancestors: ["root", "parent"],
        descendants: ["first", "deep", "second"],
    });
    assertEquals(await test.thread(root), {
        ancestors: [],
        descendants: ["parent", "note", "first", "deep", "second", "aside"],
    });
});

Deno.test("a thread leaves out the notes the viewer may not see, but not the replies under them", async () => {
    await using test = await open();
    await test.add("root", "alice", undefined, { visibility: "private" });
    const note = await test.add("note", "dave", "root");
    await test.add("secret", "alice", "note", { visibility: "private" });
    await test.add("under", "dave", "secret");

    assertEquals(await test.thread(note, "dave"), { ancestors: [], descendants: ["under"] });
    assertEquals(await test.thread(note, "bob"), {
        ancestors: ["root"],
        descendants: ["secret", "under"],
    });
});

Deno.test("a thread leaves out the notes of the accounts the viewer blocks, and the replies under them", async () => {
    await using test = await open();
    await test.add("root", "alice");
    await test.add("parent", "dave", "root");
    const note = await test.add("note", "alice", "parent");
    await test.add("blocked", "dave", "note");
    await test.add("under", "bob", "blocked");
    await test.add("other", "bob", "note");
    await test.add("deep", "dave", "other");
    await block(test.ctx, "alice", "dave");

    assertEquals(await test.thread(note, "alice"), {
        ancestors: ["root"],
        descendants: ["other"],
    });
    // Others see it all, including the blocked account.
    for (const viewer of ["bob", "dave", null]) {
        assertEquals(await test.thread(note, viewer), {
            ancestors: ["root", "parent"],
            descendants: ["blocked", "under", "other", "deep"],
        });
    }
});

Deno.test("a thread holds the 40 notes nearest above, and the 60 nearest below", async () => {
    await using test = await open();
    await test.add("0", "alice");
    for (let i = 1; i <= 45; i++) await test.add(`${i}`, "alice", `${i - 1}`);
    const note = await test.add("note", "alice", "45");
    for (let i = 0; i < 59; i++) await test.add(`reply ${i}`, "bob", "note");
    await test.add("deep", "bob", "reply 0");
    await test.add("deeper", "bob", "reply 1");

    const { ancestors, descendants } = await test.thread(note);
    assertEquals(ancestors, Array.from({ length: 40 }, (_, i) => `${i + 6}`));
    assertEquals(descendants.length, 60);
    assertEquals(descendants.slice(0, 4), ["reply 0", "deep", "reply 1", "reply 2"]);
});

Deno.test("replies the viewer may not see don't count against the 60, up to 240 looked at", async () => {
    await using test = await open();
    const note = await test.add("note", "alice");
    for (let i = 0; i < 100; i++) {
        await test.add(`hidden ${i}`, "alice", "note", { visibility: "direct" });
    }
    for (let i = 0; i < 70; i++) await test.add(`shown ${i}`, "bob", "note");

    const { descendants } = await test.thread(note);
    assertEquals(descendants, Array.from({ length: 60 }, (_, i) => `shown ${i}`));

    const third = await test.add("third", "alice");
    for (let i = 0; i < 61; i++) {
        await test.add(`kept ${i}`, "alice", "third", { visibility: "direct" });
    }
    await test.add("below", "bob", "kept 0");
    assertEquals((await test.thread(third)).descendants, ["below"]);

    const other = await test.add("other", "alice");
    for (let i = 0; i < 240; i++) {
        await test.add(`gone ${i}`, "alice", "other", { visibility: "direct" });
    }
    await test.add("late", "bob", "other");
    assertEquals((await test.thread(other)).descendants, []);
});

Deno.test("replies under a blocked one don't count against the 60, but blocked ones count against the 240", async () => {
    await using test = await open();
    await block(test.ctx, "alice", "dave");
    const note = await test.add("note", "alice");
    await test.add("blocked", "dave", "note");
    await test.add("other", "bob", "note");
    for (let i = 0; i < 60; i++) await test.add(`under ${i}`, "bob", "blocked");
    await test.add("deep", "bob", "other");

    assertEquals((await test.thread(note, "alice")).descendants, ["other", "deep"]);

    const busy = await test.add("busy", "alice");
    for (let i = 0; i < 239; i++) await test.add(`blocked ${i}`, "dave", "busy");
    await test.add("last", "bob", "busy");
    await test.add("below", "bob", "last");

    assertEquals((await test.thread(busy, "alice")).descendants, ["last"]);
});

Deno.test("a thread leaves out the notes of the accounts the viewer mutes, while the mute lasts", async () => {
    await using test = await open();
    await test.add("root", "alice");
    await test.add("parent", "dave", "root");
    const note = await test.add("note", "alice", "parent");
    await test.add("muted", "dave", "note");
    await test.add("under", "bob", "muted");
    await test.add("other", "bob", "note");
    await mute(test.ctx, "alice", "dave", { notifications: true, duration: 60 });

    assertEquals(await test.thread(note, "alice"), { ancestors: ["root"], descendants: ["other"] });
    assertEquals((await test.thread(note, "bob")).descendants, ["muted", "under", "other"]);

    test.clock.advance(60_000);
    assertEquals(await test.thread(note, "alice"), {
        ancestors: ["root", "parent"],
        descendants: ["muted", "under", "other"],
    });
});
