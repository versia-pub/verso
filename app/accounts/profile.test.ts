import { assertEquals, assertFalse, assertRejects } from "@std/assert";
import { encode } from "fast-png";
import { Unprocessable } from "../http/errors.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import type { MediaProcessed } from "../media/events.ts";
import { isProfileUpdated } from "./events.ts";
import { showProcessedPictures, updateProfile } from "./profile.ts";
import { findAccount, findAccountDecorations } from "./account_queries.ts";
import { createLocalAccount, createRemoteAccount } from "./testing.ts";

Deno.test("a remote account's profile isn't changed here", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    await test.ctx.db.insertInto("accounts")
        .values({
            id: "bob",
            username: "bob",
            instance_id: "b.example",
            remote_id: "1",
            created_at: test.clock.now(),
        })
        .execute();

    await updateProfile(test.ctx, "bob", { displayName: "Changed" });

    const { display_name } = await test.ctx.db.selectFrom("accounts")
        .select("display_name")
        .executeTakeFirstOrThrow();
    assertEquals(display_name, "");
});

Deno.test("each change to a local profile is told, with whether it unlocked it", async () => {
    const events: unknown[] = [];
    await using test = await createTestContext({
        subscribers: [(_, event) => Promise.resolve(void events.push(event))],
    });
    await createLocalAccount(test.ctx, "alice");
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "bob", "b.example");

    await updateProfile(test.ctx, "alice", {});
    await updateProfile(test.ctx, "alice", { locked: false });
    await updateProfile(test.ctx, "alice", { locked: true });
    await updateProfile(test.ctx, "alice", { locked: true });
    await updateProfile(test.ctx, "alice", { displayName: "Alice" });
    await updateProfile(test.ctx, "alice", { locked: false });
    await updateProfile(test.ctx, "bob", { locked: false });
    await updateProfile(test.ctx, "nobody", {});

    const changed = (unlocked: boolean) => ({
        type: "accounts.profile_updated",
        accountId: "alice",
        unlocked,
    });
    assertEquals(events, [
        changed(false),
        changed(false),
        changed(false),
        changed(false),
        changed(false),
        changed(true),
    ]);
    assertFalse(isProfileUpdated({ type: "graph.unfollowed" }));
});

/** A grey PNG of `side` pixels, which differs by `shade` so that files aren't the same upload. */
const png = (shade: number, side = 4) =>
    new Blob([
        new Uint8Array(encode({
            width: side,
            height: side,
            data: new Uint8Array(side * side * 4).fill(shade),
            channels: 4,
        })),
    ], { type: "image/png" });

const ogg = new Blob([new Uint8Array([79, 103, 103, 83, 1, 2])], { type: "audio/ogg" });

/** The decorations alice has, as `kind` and `position`, with the media each one is. */
const decorationsOf = async (test: Awaited<ReturnType<typeof createTestContext>>) =>
    (await findAccountDecorations(test.ctx, "alice")).map(({ kind, position, media_id }) => ({
        kind,
        position,
        media_id,
    }));

Deno.test("a local profile's pronouns, birthday, location and timezone are set and cleared", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");

    await updateProfile(test.ctx, "alice", {
        pronouns: { en: "she/her", fr: "elle" },
        birthday: "--02-29",
        location: "  Paris ",
        timezone: "Europe/Paris",
    });
    const set = await findAccount(test.ctx, "alice");

    assertEquals(set?.pronouns, { en: "she/her", fr: "elle" });
    assertEquals([set?.birthday, set?.location, set?.timezone], [
        "--02-29",
        "Paris",
        "Europe/Paris",
    ]);

    await updateProfile(test.ctx, "alice", { location: "Rome" });
    const partly = await findAccount(test.ctx, "alice");
    assertEquals([partly?.birthday, partly?.location, partly?.timezone], [
        "--02-29",
        "Rome",
        "Europe/Paris",
    ]);

    await updateProfile(test.ctx, "alice", {
        pronouns: {},
        birthday: "",
        location: "  ",
        timezone: "",
    });
    const cleared = await findAccount(test.ctx, "alice");

    assertEquals(cleared?.pronouns, {});
    assertEquals([cleared?.birthday, cleared?.location, cleared?.timezone], [null, null, null]);
});

Deno.test("pronouns replace the whole set, and blank ones are dropped", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await updateProfile(test.ctx, "alice", { pronouns: { en: "she/her", fr: "elle" } });

    await updateProfile(test.ctx, "alice", { pronouns: { de: " sie ", en: "  ", fr: "" } });

    assertEquals((await findAccount(test.ctx, "alice"))?.pronouns, { de: "sie" });
});

Deno.test("avatar overlays are replaced as a whole, in the order sent, topmost first", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");

    await updateProfile(test.ctx, "alice", { avatarOverlays: [png(10), png(20), png(30)] });
    const first = await decorationsOf(test);

    assertEquals(first.map(({ kind, position }) => [kind, position]), [
        ["avatar_overlay", 0],
        ["avatar_overlay", 1],
        ["avatar_overlay", 2],
    ]);
    assertEquals(new Set(first.map(({ media_id }) => media_id)).size, 3);

    await updateProfile(test.ctx, "alice", { avatarOverlays: [png(40)] });
    const second = await decorationsOf(test);

    assertEquals(second.map(({ kind, position }) => [kind, position]), [["avatar_overlay", 0]]);
    assertEquals(first.some(({ media_id }) => media_id === second[0]?.media_id), false);
});

Deno.test("a decoration of one kind is replaced while the other kinds stay", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await updateProfile(test.ctx, "alice", {
        avatarOverlays: [png(10)],
        avatarMask: png(20),
        background: png(30),
        audio: ogg,
    });
    const before = await decorationsOf(test);
    const idOf = (rows: typeof before, kind: string) =>
        rows.find((row) => row.kind === kind)?.media_id;

    assertEquals(before.length, 4);

    await updateProfile(test.ctx, "alice", { background: png(50) });
    const after = await decorationsOf(test);

    assertEquals(after.length, 4);
    for (const kind of ["avatar_overlay", "avatar_mask", "audio"]) {
        assertEquals(idOf(after, kind), idOf(before, kind), kind);
    }
    assertEquals(idOf(after, "background") === idOf(before, "background"), false);

    await updateProfile(test.ctx, "alice", {});
    assertEquals(await decorationsOf(test), after);
});

Deno.test("a decoration set to null is removed, and the others stay", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await updateProfile(test.ctx, "alice", {
        avatarOverlays: [png(10), png(20)],
        avatarMask: png(30),
        background: png(40),
        audio: ogg,
    });

    await updateProfile(test.ctx, "alice", { avatarOverlays: null, audio: null });
    assertEquals((await decorationsOf(test)).map(({ kind }) => kind).sort(), [
        "avatar_mask",
        "background",
    ]);

    await updateProfile(test.ctx, "alice", { avatarMask: null, background: null });
    assertEquals(await decorationsOf(test), []);
});

Deno.test("audio that isn't audio is refused, and nothing changes", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await updateProfile(test.ctx, "alice", { audio: ogg });
    const before = await decorationsOf(test);

    for (
        const file of [
            png(10),
            new Blob(["<p>"], { type: "text/html" }),
            new Blob(["x"]),
            // Playable but not audio, and audio but not playable.
            new Blob(["x"], { type: "video/mp4" }),
            new Blob(["x"], { type: "audio/x-unknown" }),
        ]
    ) {
        const error = await assertRejects(
            () => updateProfile(test.ctx, "alice", { location: "Elsewhere", audio: file }),
            Unprocessable,
        );
        assertEquals(error.description, "Audio must be audio");
    }

    assertEquals(await decorationsOf(test), before);
    assertEquals((await findAccount(test.ctx, "alice"))?.location, null);
});

Deno.test("a decoration that isn't an image is refused", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    const zip = new Blob([new Uint8Array([0x50, 0x4b, 3, 4, 1, 2])]);

    for (
        const [changes, message] of [
            [{ avatarOverlays: [png(10), zip] }, "Avatar overlay must be an image"],
            [{ avatarMask: zip }, "Avatar mask must be an image"],
            [{ background: zip }, "Background must be an image"],
        ] as const
    ) {
        const error = await assertRejects(
            () => updateProfile(test.ctx, "alice", changes),
            Unprocessable,
        );
        assertEquals(error.description, message);
    }

    assertEquals(await decorationsOf(test), []);
});

Deno.test("a decoration that finishes processing tells the profile changed, and other media doesn't", async () => {
    const events: unknown[] = [];
    await using test = await createTestContext({
        subscribers: [(_, event) => Promise.resolve(void events.push(event))],
    });
    await createLocalAccount(test.ctx, "alice");
    await updateProfile(test.ctx, "alice", {
        avatarOverlays: [png(10)],
        avatarMask: png(20),
        background: png(30),
        audio: ogg,
    });
    const decorations = await decorationsOf(test);
    events.length = 0;

    const processed = (mediaId: string): MediaProcessed => ({
        type: "media.processed",
        mediaId,
        stored: true,
    });

    // As a subscriber runs, inside the transaction of the event.
    await test.ctx.transaction(async (tx) => {
        for (const { media_id } of decorations) {
            await showProcessedPictures(tx, processed(media_id));
        }
        await showProcessedPictures(tx, processed("unrelated"));
        await showProcessedPictures(tx, { type: "graph.unfollowed" });
    });

    assertEquals(
        events,
        decorations.map(() => ({
            type: "accounts.profile_updated",
            accountId: "alice",
            unlocked: false,
        })),
    );
});
