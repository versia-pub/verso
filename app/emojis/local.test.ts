import { assertEquals, assertRejects } from "@std/assert";
import { findAccount } from "../accounts/account_queries.ts";
import { localVersiaUser } from "../accounts/federation.ts";
import { updateProfile } from "../accounts/profile.ts";
import { publicAccount } from "../accounts/public.ts";
import { accountRoutes } from "../accounts/routes.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { Limits, MediaLimits } from "../kernel/config_sections.ts";
import { createInstance } from "../instances/testing.ts";
import { findNote } from "../notes/note_queries.ts";
import { editNote, postNote } from "../notes/notes.ts";
import { renderStatuses } from "../notes/render.ts";
import { react } from "../interactions/reactions.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { keepRemoteEmojis } from "./emojis.ts";
import { emojiRoutes } from "./routes.ts";
import { createLocalEmoji } from "./testing.ts";

/** alice, with the local instance's emojis blob and cat, and b.example's dog. */
const open = async () => {
    const test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    for (const shortcode of ["blob", "cat"]) await createLocalEmoji(test.ctx, shortcode);
    await createInstance(test.ctx, "b.example");
    await keepRemoteEmojis(test.ctx, "b.example", [{
        shortcode: "dog",
        picture: { url: "https://b.example/dog.png", mediaType: "image/png" },
    }]);

    /** The shortcodes of the emojis a status uses, as the rendered status shows them. */
    const shown = async (noteId: string) => {
        const note = await findNote(test.ctx, noteId);
        const [status] = note ? await renderStatuses(test.ctx, [note], null) : [];
        return status?.emojis.map((emoji) => emoji.shortcode);
    };

    return { ...test, shown };
};

Deno.test("this instance's emojis are listed for the picker, by shortcode", async () => {
    await using test = await open();
    // One whose picture isn't processed yet isn't listed until it is.
    const id = await createLocalEmoji(test.ctx, "kept");
    await test.ctx.db.updateTable("media").set({ processed_at: null })
        .where("id", "in", (eb) => eb.selectFrom("emojis").select("media_id").where("id", "=", id))
        .execute();
    // A user's own emoji isn't global.
    const own = await createLocalEmoji(test.ctx, "mine");
    await test.ctx.db.updateTable("emojis").set({ account_id: "alice" }).where("id", "=", own)
        .execute();
    await test.ctx.db.updateTable("emojis").set({ category: "Cats" }).where("shortcode", "=", "cat")
        .execute();
    const app = createTestApp(
        test.ctx,
        emojiRoutes(MediaLimits.parse({}), Limits.parse({})),
        { checkResponses: true },
    );

    const response = await app.request("/api/v1/custom_emojis");
    assertEquals(
        await response.json(),
        ["blob", "cat"].map((shortcode) => ({
            shortcode,
            url: `https://social.example/media/emoji-${shortcode}`,
            static_url: `https://social.example/media/emoji-${shortcode}`,
            visible_in_picker: true,
            category: shortcode === "cat" ? "Cats" : null,
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

Deno.test("a local account uses this instance's emojis its name, bio and fields name", async () => {
    await using test = await open();
    const app = createTestApp(test.ctx, accountRoutes(MediaLimits.parse({}), Limits.parse({})), {
        checkResponses: true,
    });
    const shortcodes = async () => {
        const row = await findAccount(test.ctx, "alice");
        return row && (await publicAccount(test.ctx, row)).emojis.map((emoji) => emoji.shortcode);
    };

    await updateProfile(test.ctx, "alice", { displayName: "Alice :blob:", note: "Hi :cat: :dog:" });
    assertEquals(await shortcodes(), ["blob", "cat"]);

    await updateProfile(test.ctx, "alice", {
        displayName: "Alice",
        note: "Hi",
        fields: [{ name: ":cat:", value: "x" }, { name: "Site", value: ":blob:" }],
    });
    assertEquals(await shortcodes(), ["blob", "cat"]);

    // The owner sees them too, and remote instances are sent them.
    const response = await app.request("/api/v1/accounts/verify_credentials", {
        headers: { authorization: `Bearer ${await tokenFor(test.ctx, "alice")}` },
    });
    const own = await response.json();
    assertEquals(own.emojis.map((emoji: { shortcode: string }) => emoji.shortcode), [
        "blob",
        "cat",
    ]);
    const user = await localVersiaUser(test.ctx, "alice");
    assertEquals(user?.extensions, {
        "pub.versia:custom_emojis": {
            emojis: ["blob", "cat"].map((shortcode) => ({
                name: `:${shortcode}:`,
                content: {
                    "image/png": {
                        content: `https://social.example/media/emoji-${shortcode}`,
                        remote: true,
                    },
                },
            })),
        },
    });

    await updateProfile(test.ctx, "alice", { fields: [] });
    assertEquals(await shortcodes(), []);
    assertEquals((await localVersiaUser(test.ctx, "alice"))?.extensions, undefined);
});

Deno.test("text uses only emojis its author may use whose pictures are ready", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "bob");
    const bobs = await createLocalEmoji(test.ctx, "mine");
    await test.ctx.db.updateTable("emojis").set({ account_id: "bob" }).where("id", "=", bobs)
        .execute();
    for (
        const [shortcode, change] of [["waiting", { processed_at: null }], ["broken", {
            sha256: null,
        }]] as const
    ) {
        const id = await createLocalEmoji(test.ctx, shortcode);
        await test.ctx.db.updateTable("media").set(change)
            .where(
                "id",
                "in",
                (eb) => eb.selectFrom("emojis").select("media_id").where("id", "=", id),
            )
            .execute();
    }

    const note = await postNote(test.ctx, "alice", {
        text: ":mine: :waiting: :broken: :blob:",
        format: "text/plain",
        spoilerText: "",
    });
    assertEquals(await test.shown(note?.id ?? ""), ["blob"]);

    // Nor once their pictures are ready, as the status doesn't use them.
    await test.ctx.db.updateTable("media").set({ sha256: "ab", processed_at: test.clock.now() })
        .execute();
    assertEquals(await test.shown(note?.id ?? ""), ["blob"]);
});

Deno.test("global emojis have one per name, and so do each user's own", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "bob");
    /** Gives alice's or bob's emoji `shortcode`, or a global one if `accountId` is `null`. */
    const add = async (shortcode: string, accountId: string | null) => {
        const id = await createLocalEmoji(test.ctx, `${shortcode}-${test.ctx.ids()}`);
        await test.ctx.db.updateTable("emojis").set({ shortcode, account_id: accountId })
            .where("id", "=", id)
            .execute();
    };

    // Each user may have one named as a global one or another user's, and several of their own.
    await add("blob", "alice");
    await add("blob", "bob");
    await add("cat", "alice");
    await assertRejects(() => add("blob", "alice"));
    await assertRejects(() => add("cat", null));
});

Deno.test("a user's own emojis are theirs to use, over global ones of the same name", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "bob");
    for (const shortcode of ["blob", "mine"]) {
        const id = await createLocalEmoji(test.ctx, `${shortcode}_alice`);
        await test.ctx.db.updateTable("emojis").set({ shortcode, account_id: "alice" })
            .where("id", "=", id)
            .execute();
    }
    // A global one added after the user's own of its name.
    await createLocalEmoji(test.ctx, "mine");
    const app = createTestApp(
        test.ctx,
        emojiRoutes(MediaLimits.parse({}), Limits.parse({})),
        { checkResponses: true },
    );
    const own = (shortcode: string) => `https://social.example/media/emoji-${shortcode}_alice`;
    const global = (shortcode: string) => `https://social.example/media/emoji-${shortcode}`;

    /** The shortcodes and URLs of the emojis `emojis` has. */
    const urls = (emojis: readonly { shortcode: string; url: string }[] | undefined) =>
        emojis?.map((emoji) => [emoji.shortcode, emoji.url]);

    /** The emojis a status by `accountId` with `text` uses. */
    const used = async (accountId: string, text: string) => {
        const posted = await postNote(test.ctx, accountId, {
            text,
            format: "text/plain",
            spoilerText: "",
        });
        const note = await findNote(test.ctx, posted?.id ?? "");
        const [status] = note ? await renderStatuses(test.ctx, [note], null) : [];
        return urls(status?.emojis);
    };
    assertEquals(await used("alice", ":blob: :cat: :mine:"), [
        ["blob", own("blob")],
        ["cat", global("cat")],
        ["mine", own("mine")],
    ]);
    assertEquals(await used("bob", ":blob: :mine:"), [
        ["blob", global("blob")],
        ["mine", global("mine")],
    ]);

    await updateProfile(test.ctx, "alice", { displayName: "Alice :blob:" });
    const row = await findAccount(test.ctx, "alice");
    assertEquals(row && urls((await publicAccount(test.ctx, row)).emojis), [
        ["blob", own("blob")],
    ]);

    /** The emojis listed for the picker, for `accountId` or for anyone. */
    const listed = async (accountId?: string) => {
        const headers: Record<string, string> = accountId
            ? { authorization: `Bearer ${await tokenFor(test.ctx, accountId)}` }
            : {};
        return urls(await (await app.request("/api/v1/custom_emojis", { headers })).json());
    };
    assertEquals(await listed("alice"), [
        ["blob", own("blob")],
        ["cat", global("cat")],
        ["mine", own("mine")],
    ]);
    assertEquals(await listed("bob"), [
        ["blob", global("blob")],
        ["cat", global("cat")],
        ["mine", global("mine")],
    ]);
    assertEquals(await listed(), await listed("bob"));

    // Reactions are only with global ones, so a reaction's name is one emoji.
    const note = await postNote(test.ctx, "bob", {
        text: "Hi",
        format: "text/plain",
        spoilerText: "",
    });
    await react(test.ctx, "alice", note?.id ?? "", ":blob:");
    await react(test.ctx, "alice", note?.id ?? "", ":mine:");
    const reacted = await findNote(test.ctx, note?.id ?? "");
    const [status] = reacted ? await renderStatuses(test.ctx, [reacted], null) : [];
    assertEquals(urls(status?.emojis), [["blob", global("blob")], ["mine", global("mine")]]);
});
