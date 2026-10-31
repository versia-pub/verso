import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { share } from "../interactions/shares.ts";
import { findNotes } from "../notes/note_queries.ts";
import { postNote } from "../notes/notes.ts";
import { renderStatuses } from "../notes/render.ts";
import { createTestContext } from "../testing/context.ts";
import { addFilterStatus, createFilter } from "./filters.ts";

/** alice, who filters, and bob, who posts. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);

    const post = async (text: string, spoilerText = "") => {
        const note = await postNote(test.ctx, "bob", { text, format: "text/plain", spoilerText });
        if (note === undefined) throw new Error("Not posted");
        return note.id;
    };

    /** Makes a filter of alice's with `keywords`, each a whole word unless it starts with `~`. */
    const filter = async (keywords: string[], expiresIn: number | null = null) =>
        await createFilter(
            test.ctx,
            "alice",
            {
                title: "Pets",
                context: ["home"],
                action: "warn",
                expiresIn,
            },
            keywords.map((each) => ({
                keyword: each.replace(/^~/, ""),
                whole_word: !each.startsWith("~"),
            })),
        );

    /** What of `noteId` matched each of alice's filters, as she is shown it. */
    const matched = async (noteId: string) => {
        const [status] = await renderStatuses(
            test.ctx,
            await findNotes(test.ctx, [noteId]),
            "alice",
        );
        return status.filtered?.map((
            each,
        ) => [each.filter.id, each.keyword_matches, each.status_matches]);
    };

    return { ...test, post, filter, matched };
};

Deno.test("a status matches the first keyword found, as a whole word where asked, in any case", async () => {
    await using test = await open();
    const cats = await test.filter(["cat", "dog"]);
    const prefix = await test.filter(["~cat"]);
    const accented = await test.filter(["café"]);

    assertEquals(await test.matched(await test.post("My DOG and my Cat!")), [
        [cats.id, ["DOG"], null],
        [prefix.id, ["Cat"], null],
    ]);
    assertEquals(await test.matched(await test.post("A category")), [[prefix.id, ["cat"], null]]);
    assertEquals(await test.matched(await test.post("Un café, s'il vous plaît")), [[
        accented.id,
        ["café"],
        null,
    ]]);
    assertEquals(await test.matched(await test.post("Deux cafés")), []);
});

Deno.test("a status matches by its content warning too, and isn't matched for anyone else", async () => {
    await using test = await open();
    const filter = await test.filter(["spider"]);
    const posted = await test.post("Look", "Spider");

    assertEquals(await test.matched(posted), [[filter.id, ["Spider"], null]]);
    const [status] = await renderStatuses(test.ctx, await findNotes(test.ctx, [posted]), "bob");
    assertEquals(status.filtered, []);
    const [anyone] = await renderStatuses(test.ctx, await findNotes(test.ctx, [posted]), null);
    assertEquals(anyone.filtered, undefined);
});

Deno.test("a status and its boosts match a filter of either, with the same results", async () => {
    await using test = await open();
    const posted = await test.post("Hi");
    const boost = await share(test.ctx, "bob", posted);
    if (typeof boost === "string") throw new Error("Not boosted");
    const filter = await test.filter(["~h"]);
    await addFilterStatus(test.ctx, "alice", filter.id, posted);

    const result = [filter.id, ["H"], [posted]];
    assertEquals(await test.matched(posted), [result]);
    const [status] = await renderStatuses(test.ctx, [boost], "alice");
    assertEquals(status.filtered?.map((each) => each.status_matches), [[posted]]);
    assertEquals(status.reblog?.filtered, status.filtered);
});

Deno.test("a filter stops applying once it expires", async () => {
    await using test = await open();
    await test.filter(["cat"], 60);
    const posted = await test.post("A cat");

    assertEquals((await test.matched(posted))?.length, 1);
    test.clock.advance(60_000);
    assertEquals(await test.matched(posted), []);
});
