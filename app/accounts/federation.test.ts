import { assertEquals } from "@std/assert";
import { importPublicKey, v0_7 } from "@versia/protocol";
import { encode } from "fast-png";
import { requestTarget } from "../federation/request.ts";
import { instanceKey } from "../instances/keys.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { sanitizerVersion } from "../kernel/html.ts";
import { findMedia } from "../media/media_queries.ts";
import { createTestContext } from "../testing/context.ts";
import { createNetwork } from "../testing/network.ts";
import { findAccount, findAccountDecorations, findRemoteAccount } from "./account_queries.ts";
import { hasPicturesProcessing, remoteAccountOf, userType } from "./federation.ts";
import { updateProfile } from "./profile.ts";
import { saveRemoteAccount } from "./remote.ts";
import { createLocalAccount } from "./testing.ts";

/**
 * Fetches `path` from `to` as `from` would, signing the request, and checks that the response is
 * signed by `to`.
 */
const fetchSigned = async (from: Context, to: Context, path: string) => {
    const url = new URL(path, to.urls.origin);
    const target = requestTarget(url);
    const headers = await v0_7.sign(
        { method: "GET", host: to.urls.domain, target, body: new Uint8Array() },
        (await instanceKey(from)).privateKey,
        from.urls.domain,
        from.clock.now(),
    );

    const response = await from.transport(
        new Request(`${to.urls.origin}${path}`, {
            headers: { ...headers, accept: "application/vnd.versia+json" },
        }),
    );
    const body = new Uint8Array(await response.arrayBuffer());
    const theirs = await importPublicKey((await instanceKey(to)).publicKey);
    const signature = await v0_7.verify(
        { method: "GET", host: to.urls.domain, target, body },
        response.headers,
        (signer) => Promise.resolve(signer === to.urls.domain ? theirs : undefined),
        from.clock.now(),
    );

    return {
        status: response.status,
        type: response.headers.get("content-type"),
        signedBy: signature.ok ? signature.signedBy : undefined,
        body: JSON.parse(new TextDecoder().decode(body)),
    };
};

const defaultHeader = (id: string) => ({
    url: `https://a.test/accounts/${id}/header.png`,
    media_type: "image/png",
});

Deno.test("another instance fetches a local user, signed both ways", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    await createLocalAccount(a, "alice");
    await updateProfile(a, "alice", {
        displayName: "Alice",
        note: "Hi <there>",
        fields: [{ name: "Site & more", value: "a & b" }],
        locked: true,
        indexable: true,
    });

    const response = await fetchSigned(b, a, "/.versia/v0.7/entities/User/alice");

    assertEquals(response, {
        status: 200,
        type: "application/vnd.versia+json; charset=utf-8",
        signedBy: "a.test",
        body: {
            type: "User",
            id: "alice",
            created_at: a.clock.now().toISOString(),
            updated_at: a.clock.now().toISOString(),
            username: "alice",
            display_name: "Alice",
            avatar: { url: "https://a.test/accounts/alice/avatar.png", media_type: "image/png" },
            manually_approves_subscribers: true,
            indexable: true,
            url: "https://a.test/@alice",
            extensions: {
                [v0_7.profileKey]: {
                    bio: "<p>Hi &lt;there&gt;</p>",
                    fields: [{ key: "Site &amp; more", value: "a &amp; b" }],
                },
                [v0_7.decorationsKey]: { header: defaultHeader("alice") },
            },
        },
    });
    assertEquals(v0_7.User.parse(response.body).username, "alice");
});

Deno.test("a user's own pictures are given once processed, and the default ones until then", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    await createLocalAccount(a, "alice");
    const png = new Uint8Array(encode({
        width: 800,
        height: 200,
        data: new Uint8Array(800 * 200 * 4).fill(200),
        channels: 4,
    }));
    await updateProfile(a, "alice", {
        avatar: { file: new Blob([png]), description: "Me" },
        header: { file: new Blob([png]) },
    });

    const pending = await fetchSigned(b, a, "/.versia/v0.7/entities/User/alice");
    assertEquals(pending.body.avatar, {
        url: "https://a.test/accounts/alice/avatar.png",
        media_type: "image/png",
    });

    await network.drain();

    const { body } = await fetchSigned(b, a, "/.versia/v0.7/entities/User/alice");
    const user = v0_7.User.parse(body);
    const avatar = user.avatar;
    assertEquals(avatar?.url, `https://a.test/media/${avatar?.hash}`);
    assertEquals(
        [avatar?.media_type, avatar?.width, avatar?.height, avatar?.description],
        ["image/png", 400, 100, "Me"],
    );

    const header = v0_7.Decorations.parse(user.extensions?.[v0_7.decorationsKey]).header;
    assertEquals([header?.url, header?.width], [`https://a.test/media/${header?.hash}`, 800]);
});

Deno.test("a user without a name or bio leaves them out", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    await createLocalAccount(a, "bob");

    const { body } = await fetchSigned(
        network.instances["b.test"].ctx,
        a,
        "/.versia/v0.7/entities/User/bob",
    );

    assertEquals(
        [body.display_name, body.manually_approves_subscribers, body.indexable],
        [undefined, false, false],
    );
    assertEquals(body.extensions, { [v0_7.decorationsKey]: { header: defaultHeader("bob") } });
});

/** A processed local file of `media_type` for `ctx`, stored under the SHA-256 `digit` repeated. */
const createFile = async (ctx: Context, digit: string, mediaType: string, processed = true) => {
    const id = ctx.ids();
    await ctx.db.insertInto("media")
        .values({
            id,
            instance_id: null,
            media_type: mediaType,
            sha256: digit.repeat(64),
            // An image Verso processed has a preview, and is served as its own type.
            preview_sha256: mediaType.startsWith("image/") ? digit.repeat(64) : null,
            processed_at: processed ? ctx.clock.now() : null,
            created_at: ctx.clock.now(),
        })
        .execute();

    return id;
};

Deno.test("a local user's pronouns, details and decorations are given, apart from unprocessed ones", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    await createLocalAccount(a, "alice");
    await a.db.updateTable("accounts")
        .set({
            pronouns: { en: "she/her" },
            birthday: "--03-04",
            location: "Paris",
            timezone: "Europe/Paris",
        })
        .execute();
    const decorations = [
        ["avatar_overlay", 0, await createFile(a, "1", "image/png")],
        ["avatar_overlay", 1, await createFile(a, "2", "image/webp")],
        ["avatar_mask", 0, await createFile(a, "3", "image/png", false)],
        ["background", 0, await createFile(a, "4", "image/png")],
        ["audio", 0, await createFile(a, "5", "audio/ogg")],
    ] as const;
    await a.db.insertInto("account_decorations")
        .values(decorations.map(([kind, position, media_id]) => ({
            account_id: "alice",
            kind,
            position,
            media_id,
        })))
        .execute();

    const { body } = await fetchSigned(b, a, "/.versia/v0.7/entities/User/alice");

    const user = v0_7.User.parse(body);
    assertEquals(user.extensions?.[v0_7.profileKey], {
        pronouns: { en: "she/her" },
        birthday: "--03-04",
        location: "Paris",
        timezone: "Europe/Paris",
    });
    assertEquals(user.extensions?.[v0_7.decorationsKey], {
        header: defaultHeader("alice"),
        avatar_overlays: [
            {
                url: `https://a.test/media/${"1".repeat(64)}`,
                media_type: "image/png",
                hash: "1".repeat(64),
            },
            {
                url: `https://a.test/media/${"2".repeat(64)}`,
                media_type: "image/webp",
                hash: "2".repeat(64),
            },
        ],
        background: {
            url: `https://a.test/media/${"4".repeat(64)}`,
            media_type: "image/png",
            hash: "4".repeat(64),
        },
        audio: {
            url: `https://a.test/media/${"5".repeat(64)}`,
            media_type: "audio/ogg",
            hash: "5".repeat(64),
        },
    });
});

Deno.test("only local users are given, and only to other instances", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    await createLocalAccount(a, "alice");
    await a.db.insertInto("accounts")
        .values({
            id: "remote",
            username: "carol",
            instance_id: await createInstance(a, "c.test"),
            remote_id: "carol",
            created_at: a.clock.now(),
        })
        .execute();

    const unsigned = await b.transport(
        new Request("https://a.test/.versia/v0.7/entities/User/alice"),
    );
    assertEquals(unsigned.status, 401);
    for (const id of ["remote", "missing"]) {
        assertEquals(
            (await fetchSigned(b, a, `/.versia/v0.7/entities/User/${id}`)).status,
            404,
            id,
        );
    }
});

Deno.test("a local user's collections are given, empty until there is something in them", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    await createLocalAccount(a, "alice");
    const collection = (path: string) => fetchSigned(b, a, `/.versia/v0.7/entities/User/${path}`);

    for (const name of ["pub.versia:social/Notes", "pub.versia:social/Featured"]) {
        assertEquals(await collection(`alice/collections/${name}?offset=10&limit=20`), {
            status: 200,
            type: "application/vnd.versia+json; charset=utf-8",
            signedBy: "a.test",
            body: { total: 0, items: [] },
        }, name);
    }

    assertEquals((await collection("alice/collections/likes")).status, 404);
    assertEquals((await collection("missing/collections/pub.versia:social/Notes")).status, 404);
    for (const query of ["offset=-1", "offset=a", "limit=1.5"]) {
        assertEquals(
            (await collection(`alice/collections/pub.versia:social/Notes?${query}`)).status,
            422,
            query,
        );
    }

    const unsigned = await b.transport(
        new Request(
            "https://a.test/.versia/v0.7/entities/User/alice/collections/pub.versia:social/Notes",
        ),
    );
    assertEquals(unsigned.status, 401);
});

const user = (changes: Partial<v0_7.User> = {}): v0_7.User => ({
    type: "User",
    id: "abc",
    created_at: "2026-01-01T00:00:00Z",
    username: "bob",
    manually_approves_subscribers: false,
    indexable: true,
    ...changes,
});

/** A user with `profile` and `decorations` as its extensions. */
const withExtensions = (
    profile: v0_7.Profile | Record<string, unknown> | undefined,
    decorations: v0_7.Decorations | undefined = undefined,
    changes: Partial<v0_7.User> = {},
): v0_7.User =>
    user({
        ...changes,
        extensions: {
            ...profile && { [v0_7.profileKey]: profile },
            ...decorations && { [v0_7.decorationsKey]: decorations },
        },
    });

const image = (name: string): v0_7.Media => ({
    url: `https://b.test/${name}.png`,
    media_type: "image/png",
});

Deno.test("a remote user becomes an account, with its text as plain text and as HTML", () => {
    const account = remoteAccountOf(
        "b.test",
        withExtensions(
            {
                bio: "<p>Hi <b>there</b></p>",
                fields: [{ key: "Site", value: '<a href="https://b.test">b.test</a>' }],
                pronouns: { en: "he/him" },
                birthday: "1990-05-06",
                location: "Berlin",
                timezone: "Europe/Berlin",
            },
            undefined,
            { display_name: "Bob", manually_approves_subscribers: true },
        ),
    );

    assertEquals(account, {
        instanceId: "b.test",
        remoteId: "abc",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: null,
        profile: {
            username: "bob",
            display_name: "Bob",
            note: "Hi there",
            note_format: "text/plain",
            note_html: "<p>Hi <b>there</b></p>",
            fields: [{
                name: "Site",
                value: "b.test",
                format: "text/plain",
                name_html: "Site",
                value_html:
                    '<a rel="nofollow noopener noreferrer" target="_blank" href="https://b.test">b.test</a>',
            }],
            pronouns: { en: "he/him" },
            birthday: "1990-05-06",
            location: "Berlin",
            timezone: "Europe/Berlin",
            url: null,
            html_version: sanitizerVersion,
            locked: true,
            indexable: true,
        },
        avatar: null,
        header: null,
        decorations: [],
        emojis: [],
    });
});

Deno.test("a remote user without a profile has an empty one, and manually_approves_subscribers locks it", () => {
    const open = remoteAccountOf("b.test", user());
    const locked = remoteAccountOf("b.test", user({ manually_approves_subscribers: true }));

    assertEquals(
        [open.profile.display_name, open.profile.note, open.profile.note_html, open.profile.fields],
        ["", "", "", []],
    );
    assertEquals(
        [
            open.profile.pronouns,
            open.profile.birthday,
            open.profile.location,
            open.profile.timezone,
            open.profile.url,
        ],
        [{}, null, null, null, null],
    );
    assertEquals([open.profile.locked, locked.profile.locked], [false, true]);
});

Deno.test("a remote user's web page is kept, unless its URL is longer than 2048 characters", () => {
    const long = `https://b.test/${"a".repeat(2048)}`;

    const kept = remoteAccountOf("b.test", user({ url: "https://b.test/@bob" }));
    const dropped = remoteAccountOf("b.test", user({ url: long }));

    assertEquals([kept.profile.url, dropped.profile.url], ["https://b.test/@bob", null]);
});

Deno.test("a remote field named with HTML is named by its text", () => {
    const account = remoteAccountOf(
        "b.test",
        withExtensions({ fields: [{ key: "<b>Site</b> &amp;\n more", value: "b.test" }] }),
    );

    assertEquals(
        [account.profile.fields[0].name, account.profile.fields[0].name_html],
        ["Site & more", "<b>Site</b> &amp;\n more"],
    );
});

Deno.test("a remote account's HTML is sanitised", () => {
    const unsafe = '<p onclick="x">Hi</p><script>bad()</script>';
    const account = remoteAccountOf(
        "b.test",
        withExtensions({ bio: unsafe, fields: [{ key: unsafe, value: unsafe }] }),
    );

    assertEquals(
        [
            account.profile.note_html,
            account.profile.fields[0].name_html,
            account.profile.fields[0].value_html,
            account.profile.html_version,
        ],
        ["<p>Hi</p>", "<p>Hi</p>", "<p>Hi</p>", sanitizerVersion],
    );
});

Deno.test("a remote picture is a version clients can show, at a web address", () => {
    const hash = "AB".repeat(32);
    const account = remoteAccountOf(
        "b.test",
        withExtensions(
            undefined,
            { header: { url: "https://b.test/sea.svg", media_type: "image/svg+xml" } },
            {
                avatar: {
                    url: "https://b.test/bob.webp",
                    media_type: "image/webp",
                    size: 1234,
                    hash: hash.toLowerCase(),
                    width: 64,
                    height: 48,
                    thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
                    description: "Bob",
                },
            },
        ),
    );

    assertEquals(account.avatar, {
        url: "https://b.test/bob.webp",
        mediaType: "image/webp",
        size: 1234,
        sha256: "ab".repeat(32),
        width: 64,
        height: 48,
        thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
        description: "Bob",
    });
    assertEquals(account.header, null);
});

Deno.test("a remote user's decorations are its header, overlays in order, mask, background and audio", () => {
    const account = remoteAccountOf(
        "b.test",
        withExtensions(undefined, {
            header: image("header"),
            avatar_overlays: [image("top"), image("bottom")],
            avatar_mask: image("mask"),
            background: image("background"),
            audio: { url: "https://b.test/song.ogg", media_type: "audio/ogg" },
        }),
    );

    assertEquals(account.header?.url, "https://b.test/header.png");
    assertEquals(
        account.decorations.map(({ kind, position, media }) => [kind, position, media.url]),
        [
            ["avatar_overlay", 0, "https://b.test/top.png"],
            ["avatar_overlay", 1, "https://b.test/bottom.png"],
            ["avatar_mask", 0, "https://b.test/mask.png"],
            ["background", 0, "https://b.test/background.png"],
            ["audio", 0, "https://b.test/song.ogg"],
        ],
    );
});

Deno.test("a remote user keeps at most ten avatar overlays, and skips those clients can't show", () => {
    const overlays = Array.from({ length: 15 }, (_, index) => image(`overlay${index}`));
    const account = remoteAccountOf(
        "b.test",
        withExtensions(undefined, {
            avatar_overlays: [
                { url: "https://b.test/art.svg", media_type: "image/svg+xml" },
                ...overlays,
            ],
        }),
    );

    assertEquals(
        account.decorations.map(({ position, media }) => [position, media.url]),
        overlays.slice(0, 10).map(({ url }, position) => [position, url]),
    );
});

Deno.test("a remote profile that doesn't match Versia's is ignored, and the user is still saved", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.test");
    const invalid = remoteAccountOf(
        "b.test",
        withExtensions({ bio: "<p>Hi</p>", timezone: "Not/AZone" }, { header: image("header") }, {
            display_name: "Bob",
        }),
    );

    assertEquals(
        [invalid.profile.display_name, invalid.profile.note_html, invalid.profile.timezone],
        ["Bob", "", null],
    );
    assertEquals(invalid.header?.url, "https://b.test/header.png");
    assertEquals(typeof await saveRemoteAccount(test.ctx, invalid), "string");
});

Deno.test("a received user stores its profile and decorations, and loses them when it stops giving them", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.test");
    const full = withExtensions({
        bio: "<p>Hi</p>",
        fields: [{ key: "Site", value: "b.test" }],
        pronouns: { en: "he/him" },
        birthday: "1990-05-06",
        location: "Berlin",
        timezone: "Europe/Berlin",
    }, {
        header: image("header"),
        avatar_overlays: [image("top"), image("bottom")],
        avatar_mask: image("mask"),
        background: image("background"),
        audio: { url: "https://b.test/song.ogg", media_type: "audio/ogg" },
    }, { avatar: image("avatar"), url: "https://b.test/@bob" });

    const id = await saveRemoteAccount(test.ctx, remoteAccountOf("b.test", full));

    const row = await findAccount(test.ctx, id);
    assertEquals(
        [row?.note_html, row?.fields.length, row?.pronouns, row?.birthday, row?.location],
        ["<p>Hi</p>", 1, { en: "he/him" }, "1990-05-06", "Berlin"],
    );
    assertEquals([row?.timezone, row?.url], ["Europe/Berlin", "https://b.test/@bob"]);
    assertEquals(
        (await findMedia(test.ctx, row?.header_id ?? ""))?.url,
        "https://b.test/header.png",
    );
    assertEquals(
        (await findAccountDecorations(test.ctx, id)).map(({ kind, position }) => [kind, position]),
        [
            ["audio", 0],
            ["avatar_mask", 0],
            ["avatar_overlay", 0],
            ["avatar_overlay", 1],
            ["background", 0],
        ],
    );
    assertEquals((await test.ctx.db.selectFrom("media").select("id").execute()).length, 7);

    await saveRemoteAccount(test.ctx, remoteAccountOf("b.test", user()));

    const bare = await findAccount(test.ctx, id);
    assertEquals(
        [
            bare?.note_html,
            bare?.pronouns,
            bare?.birthday,
            bare?.location,
            bare?.timezone,
            bare?.url,
        ],
        ["", {}, null, null, null, null],
    );
    assertEquals(bare?.header_id, null);
    assertEquals(await findAccountDecorations(test.ctx, id), []);
    assertEquals(await test.ctx.db.selectFrom("media").select("id").execute(), []);
});

Deno.test("a received user is kept unless it is older than the held one or has another created_at", async () => {
    await using test = await createTestContext();
    const instanceId = await createInstance(test.ctx, "b.test");
    const sender = { domain: "b.test", instanceId, fetched: true };
    const receive = (changes: Partial<v0_7.User>) =>
        userType.receive(test.ctx, user({ ...changes }), sender);
    const display = async () => (await findRemoteAccount(test.ctx, instanceId, "abc"))?.updated_at;
    const name = async () => {
        const held = await findRemoteAccount(test.ctx, instanceId, "abc");
        return (await findAccount(test.ctx, held?.id ?? ""))?.display_name;
    };

    await receive({ display_name: "Second", updated_at: "2026-02-01T00:00:00Z" });

    assertEquals(await display(), new Date("2026-02-01T00:00:00Z"));
    assertEquals(await name(), "Second");

    await receive({ display_name: "First", updated_at: "2026-01-15T00:00:00Z" });

    assertEquals(await name(), "Second");

    await receive({
        display_name: "Other",
        created_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-03-01T00:00:00Z",
    });

    assertEquals(await name(), "Second");
    assertEquals(await display(), new Date("2026-02-01T00:00:00Z"));

    await receive({ display_name: "Third", updated_at: "2026-02-02T00:00:00Z" });

    assertEquals(await name(), "Third");
    assertEquals(await display(), new Date("2026-02-02T00:00:00Z"));

    await receive({ display_name: "Last" });

    assertEquals(await name(), "Last");
    assertEquals(await display(), null);
});

Deno.test("a local profile edit sets updated_at, and the user given carries it", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    await createLocalAccount(a, "alice");

    assertEquals((await findAccount(a, "alice"))?.updated_at, null);
    assertEquals(
        (await fetchSigned(b, a, "/.versia/v0.7/entities/User/alice")).body.updated_at,
        undefined,
    );

    network.clock.advance(60_000);
    await updateProfile(a, "alice", { displayName: "Alice" });

    const edited = a.clock.now();
    assertEquals((await findAccount(a, "alice"))?.updated_at, edited);
    assertEquals(
        (await fetchSigned(b, a, "/.versia/v0.7/entities/User/alice")).body.updated_at,
        edited.toISOString(),
    );
});

Deno.test("an account has pictures processing while any of its decorations is", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    assertEquals(await hasPicturesProcessing(test.ctx, "alice"), false);

    const done = await createFile(test.ctx, "1", "image/png");
    const pending = await createFile(test.ctx, "2", "audio/ogg", false);
    await test.ctx.db.insertInto("account_decorations")
        .values([
            { account_id: "alice", kind: "avatar_overlay", position: 0, media_id: done },
            { account_id: "alice", kind: "audio", position: 0, media_id: pending },
        ])
        .execute();
    assertEquals(await hasPicturesProcessing(test.ctx, "alice"), true);

    await test.ctx.db.updateTable("media").set({ processed_at: test.clock.now() })
        .where("id", "=", pending).execute();
    assertEquals(await hasPicturesProcessing(test.ctx, "alice"), false);
});
