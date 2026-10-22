import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { findNote } from "../notes/note_queries.ts";
import { editNote, postNote } from "../notes/notes.ts";
import { renderStatuses } from "../notes/render.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { keepRemoteEmojis } from "./emojis.ts";
import { emojiRoutes } from "./routes.ts";
import { createLocalEmoji } from "./testing.ts";

/** alice, with this instance's emojis blob and cat, and b.example's dog. */
const open = async () => {
    const test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    for (const shortcode of ["blob", "cat"]) await createLocalEmoji(test.ctx, shortcode);
    await createInstance(test.ctx, "b.example");
    await keepRemoteEmojis(test.ctx, "b.example", [{
        shortcode: "dog",
        picture: { url: "https://b.example/dog.png", mediaType: "image/png" },
    }]);

    /** The shortcodes of the emojis a note uses, as its status shows them. */
    const shown = async (noteId: string) => {
        const note = await findNote(test.ctx, noteId);
        const [status] = note ? await renderStatuses(test.ctx, [note], null) : [];
        return status?.emojis.map((emoji) => emoji.shortcode);
    };

    return { ...test, shown };
};

Deno.test("this instance's emojis are listed for the picker, by shortcode", async () => {
    await using test = await open();
    // One Verso keeps the picture of itself isn't listed until Verso can serve it.
    const id = await createLocalEmoji(test.ctx, "kept");
    await test.ctx.db.updateTable("media").set({ url: null })
        .where("id", "in", (eb) => eb.selectFrom("emojis").select("media_id").where("id", "=", id))
        .execute();
    const app = createTestApp(test.ctx, emojiRoutes, { checkResponses: true });

    const response = await app.request("/api/v1/custom_emojis");
    assertEquals(
        await response.json(),
        ["blob", "cat"].map((shortcode) => ({
            shortcode,
            url: `https://pictures.example/${shortcode}.png`,
            static_url: `https://pictures.example/${shortcode}.png`,
            visible_in_picker: true,
            category: null,
        })),
    );
});

Deno.test("a local note uses this instance's emojis its text and warning name", async () => {
    await using test = await open();

    const note = await postNote(test.ctx, "alice", {
        text: "Hi :cat: :dog: :nope: and:blob:",
        format: "text/plain",
        spoilerText: "Look :blob:",
    });
    assertEquals(await test.shown(note?.id ?? ""), ["blob", "cat"]);

    await editNote(test.ctx, "alice", note?.id ?? "", { text: "Hi :cat:", spoilerText: "" });
    assertEquals(await test.shown(note?.id ?? ""), ["cat"]);
});
