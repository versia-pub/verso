import { assertEquals } from "@std/assert";
import { encode } from "fast-png";
import { createLocalAccount, createRole, giveRole } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { Limits, MediaLimits } from "../kernel/config_sections.ts";
import { findNote } from "../notes/note_queries.ts";
import { postNote } from "../notes/notes.ts";
import { renderStatuses } from "../notes/render.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { keepRemoteEmojis } from "./emojis.ts";
import { emojiRoutes } from "./routes.ts";

/** A `width`×`height` PNG of noise, which doesn't compress, from xorshift. */
const noise = (width: number, height: number) => {
    let state = 1;
    const data = new Uint8Array(width * height * 4).map(() => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state & 255;
    });

    return new Uint8Array(encode({ width, height, data, channels: 4 }));
};

/** A form with each of `fields`, files given as their bytes. */
const formOf = (fields: Record<string, string | Uint8Array<ArrayBuffer>>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) {
        form.append(name, typeof value === "string" ? value : new File([value], `${name}.png`));
    }

    return form;
};

/** alice and bob, and admin, who may add global emojis. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "admin"]) await createLocalAccount(test.ctx, id);
    await giveRole(test.ctx, "admin", await createRole(test.ctx, "Admin", ["emojis"]));
    const app = createTestApp(test.ctx, emojiRoutes(MediaLimits.parse({}), Limits.parse({})), {
        checkResponses: true,
    });

    /** Adds an emoji as `accountId`, from a form of `fields`, with a small picture by default. */
    const add = async (
        accountId: string,
        fields: Record<string, string | Uint8Array<ArrayBuffer>>,
    ) => {
        const response = await app.request("/api/v1/emojis", {
            method: "POST",
            headers: { authorization: `Bearer ${await tokenFor(test.ctx, accountId)}` },
            body: formOf({ element: noise(16, 16), ...fields }),
        });

        return { status: response.status, body: await response.json() };
    };

    /** The shortcodes of the emojis listed for the picker. */
    const listed = async () => {
        const response = await app.request("/api/v1/custom_emojis");
        return (await response.json()).map((emoji: { shortcode: string }) => emoji.shortcode);
    };

    /** The shortcodes of the emojis a status by alice with `text` uses. */
    const used = async (text: string) => {
        const posted = await postNote(test.ctx, "alice", {
            text,
            format: "text/plain",
            spoilerText: "",
        });
        const note = await findNote(test.ctx, posted?.id ?? "");
        const [status] = note ? await renderStatuses(test.ctx, [note], null) : [];
        return status?.emojis.map((emoji) => emoji.shortcode);
    };

    return { ...test, add, listed, used };
};

Deno.test("a global emoji is used once its picture is processed, scaled to fit", async () => {
    await using test = await open();

    const { status, body } = await test.add("admin", {
        shortcode: "blob_fox",
        element: noise(300, 200),
        alt: "A fox",
        category: "Foxes",
        global: "true",
    });
    assertEquals(status, 202);
    assertEquals(body, {
        id: body.id,
        shortcode: "blob_fox",
        url: null,
        static_url: null,
        visible_in_picker: true,
        category: "Foxes",
        global: true,
        description: "A fox",
    });
    assertEquals(await test.used(":blob_fox:"), []);
    assertEquals(await test.listed(), []);

    await drain(test.ctx, queues);
    assertEquals(await test.used(":blob_fox:"), ["blob_fox"]);
    assertEquals(await test.listed(), ["blob_fox"]);

    const picture = await test.ctx.db.selectFrom("media").select(["width", "height"])
        .where(
            "id",
            "in",
            (eb) => eb.selectFrom("emojis").select("media_id").where("id", "=", body.id),
        )
        .executeTakeFirst();
    assertEquals(picture, { width: 128, height: 85 });
});

Deno.test("a user's emoji is their own, and only those allowed add global emojis", async () => {
    await using test = await open();

    const own = await test.add("alice", { shortcode: "mine" });
    assertEquals([own.status, own.body.global, own.body.description], [202, false, null]);
    await drain(test.ctx, queues);
    assertEquals(await test.listed(), []);

    const global = await test.add("alice", { shortcode: "ours", global: "true" });
    assertEquals(global.status, 403);
});

Deno.test("a user can't add an emoji named as one they may already use", async () => {
    await using test = await open();
    assertEquals((await test.add("admin", { shortcode: "blob", global: "true" })).status, 202);
    assertEquals((await test.add("alice", { shortcode: "fox" })).status, 202);

    // Their own, or a global one.
    assertEquals((await test.add("alice", { shortcode: "fox" })).status, 422);
    const taken = await test.add("alice", { shortcode: "blob" });
    assertEquals([taken.status, taken.body.error_description], [
        422,
        "An emoji named blob already exists, yours or global",
    ]);

    // Another user's isn't theirs to use, nor a remote instance's.
    assertEquals((await test.add("bob", { shortcode: "fox" })).status, 202);
    assertEquals((await test.add("admin", { shortcode: "fox", global: "true" })).status, 202);
    await createInstance(test.ctx, "b.example");
    await keepRemoteEmojis(test.ctx, "b.example", [{
        shortcode: "dog",
        picture: { url: "https://b.example/dog.png", mediaType: "image/png" },
    }]);
    assertEquals((await test.add("alice", { shortcode: "dog" })).status, 202);

    // Nor if one is added while another of the same name is.
    const both = await Promise.all([1, 2].map(() => test.add("alice", { shortcode: "owl" })));
    assertEquals(both.map((added) => added.status).sort(), [202, 422]);

    // Nor may a global one be added named as one of the adder's own.
    assertEquals((await test.add("admin", { shortcode: "cat" })).status, 202);
    assertEquals((await test.add("admin", { shortcode: "cat", global: "true" })).status, 422);
});

Deno.test("an emoji is named as text can use it, with a picture that is an image", async () => {
    await using test = await open();

    for (const shortcode of ["a", "blob-fox", "blob fox", "x".repeat(101)]) {
        assertEquals((await test.add("alice", { shortcode })).status, 422, shortcode);
    }
    assertEquals((await test.add("alice", { shortcode: "x".repeat(100) })).status, 202);

    const text = await test.add("alice", {
        shortcode: "text",
        element: new TextEncoder().encode("Not a picture"),
    });
    assertEquals([text.status, text.body.error_description], [422, "The picture must be an image"]);

    // Over 256 KiB, and over what the request may be at all.
    const large = await test.add("alice", { shortcode: "large", element: noise(260, 260) });
    assertEquals(large.status, 422);
    const larger = await test.add("alice", { shortcode: "large", element: noise(300, 300) });
    assertEquals(larger.status, 413);
});
