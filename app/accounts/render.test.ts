import { assertEquals, assertExists } from "@std/assert";
import { Account, CredentialAccount, Profile } from "@versia/client-api";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { sanitizerVersion } from "../kernel/html.ts";
import { createTestContext } from "../testing/context.ts";
import type { MediaRow } from "../media/media_queries.ts";
import { findAccount, type ShownDecoration } from "./account_queries.ts";
import { saveRemoteAccount } from "./remote.ts";
import { renderAccount, renderCredentialAccount, renderProfile } from "./render.ts";
import type { RoleRow } from "./role_queries.ts";
import type { DecorationKind, ProfileField } from "./tables.ts";
import { createLocalAccount } from "./testing.ts";

const find = async (ctx: Context, id: string) => {
    const row = await findAccount(ctx, id);
    assertExists(row);
    return row;
};

Deno.test("a local account links to itself on this instance", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    await test.ctx.db.updateTable("accounts")
        .set({ created_at: new Date("2026-01-31T15:04:05Z") })
        .execute();

    const account = Account.parse(renderAccount(test.ctx, await find(test.ctx, id), [], [], []));

    assertEquals(account.acct, "alice");
    assertEquals(account.uri, "https://social.example/.versia/v0.7/entities/User/alice");
    assertEquals(account.url, "https://social.example/@alice");
    assertEquals(account.avatar, "https://social.example/accounts/alice/avatar.png");
    assertEquals(account.header_static, "https://social.example/accounts/alice/header.png");
    assertEquals(account.created_at, "2026-01-31T00:00:00.000Z");
    assertEquals(account.last_status_at, null);
    assertEquals(account.roles, []);
});

Deno.test("a remote account links to its own instance", async () => {
    await using test = await createTestContext();
    const instance = await createInstance(test.ctx, "b.example");
    await test.ctx.db.insertInto("accounts")
        .values({
            id: "r",
            username: "bob",
            instance_id: instance,
            remote_id: "a/b",
            created_at: test.ctx.clock.now(),
            last_status_at: new Date("2026-02-01T23:59:00Z"),
        })
        .execute();

    const account = Account.parse(renderAccount(test.ctx, await find(test.ctx, "r"), [], [], []));

    assertEquals(account.acct, "bob@b.example");
    assertEquals(account.uri, "https://b.example/.versia/v0.7/entities/User/a%2Fb");
    assertEquals(account.url, "https://social.example/@bob@b.example");
    assertEquals(account.avatar, "https://social.example/accounts/r/avatar.png");
    assertEquals(account.last_status_at, "2026-02-01");
    assertEquals(account.roles, null);
});

Deno.test("a remote account shows its own pictures, and its HTML made safe", async () => {
    await using test = await createTestContext();
    const instanceId = await createInstance(test.ctx, "b.example");
    const unsafe = '<p class="mention x">Hi<script>alert(1)</script></p>';
    const safe = '<p class="mention">Hi</p>';
    const id = await saveRemoteAccount(test.ctx, {
        instanceId,
        remoteId: "bob",
        createdAt: test.clock.now(),
        profile: {
            username: "bob",
            display_name: "",
            note: "Hi",
            note_format: "text/plain",
            note_html: unsafe,
            fields: [{
                name: "Site",
                value: "Hi",
                format: "text/plain",
                name_html: "Site",
                value_html: unsafe,
            }],
            // Stored as received, before HTML was sanitised on arrival.
            pronouns: {},
            birthday: null,
            location: null,
            timezone: null,
            url: null,
            html_version: 0,
            locked: false,
            indexable: true,
        },
        avatar: {
            url: "https://pictures.example/bob.png",
            mediaType: "image/png",
            description: "Bob",
        },
        header: null,
        decorations: [],
        emojis: [],
    });

    const account = Account.parse(renderAccount(test.ctx, await find(test.ctx, id), [], [], []));

    assertEquals(account.note, safe);
    assertEquals(account.fields, [{ name: "Site", value: safe, verified_at: null }]);
    assertEquals([account.avatar, account.avatar_static], [
        "https://pictures.example/bob.png",
        "https://pictures.example/bob.png",
    ]);
    assertEquals(account.avatar_description, "Bob");
    assertEquals(account.header, `https://social.example/accounts/${id}/header.png`);
    assertEquals(account.header_description, "");

    // Once cached, the pictures are served by Verso, with the preview as the still.
    const { avatar_id } = await find(test.ctx, id);
    assertExists(avatar_id);
    await test.ctx.db.updateTable("media")
        .set({ sha256: "ab", preview_sha256: "cd", processed_at: test.clock.now() })
        .where("id", "=", avatar_id)
        .execute();
    const cached = Account.parse(renderAccount(test.ctx, await find(test.ctx, id), [], [], []));
    assertEquals([cached.avatar, cached.avatar_static], [
        "https://social.example/media/ab",
        "https://social.example/media/cd",
    ]);

    // Caching that failed leaves the picture at its URL.
    await test.ctx.db.updateTable("media").set({ sha256: null }).execute();
    assertEquals(
        Account.parse(renderAccount(test.ctx, await find(test.ctx, id), [], [], [])).avatar,
        "https://pictures.example/bob.png",
    );
});

Deno.test("a remote account's HTML, sanitised when it was stored, is shown as it is", async () => {
    await using test = await createTestContext();
    const instanceId = await createInstance(test.ctx, "b.example");
    // Not as this sanitiser would leave it, to show it isn't sanitised again.
    const stored = '<p onclick="x">Hi</p>';
    const id = await saveRemoteAccount(test.ctx, {
        instanceId,
        remoteId: "bob",
        createdAt: test.clock.now(),
        profile: {
            username: "bob",
            display_name: "",
            note: "Hi",
            note_format: "text/plain",
            note_html: stored,
            fields: [{
                name: "Site",
                value: "Hi",
                format: "text/plain",
                name_html: "Site",
                value_html: stored,
            }],
            pronouns: {},
            birthday: null,
            location: null,
            timezone: null,
            url: null,
            html_version: sanitizerVersion,
            locked: false,
            indexable: true,
        },
        avatar: null,
        header: null,
        decorations: [],
        emojis: [],
    });

    const account = renderAccount(test.ctx, await find(test.ctx, id), [], [], []);
    assertEquals([account.note, account.fields[0].value], [stored, stored]);
});

Deno.test("others see the bio and fields as HTML, and their owner as written", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    const field: ProfileField = {
        name: "Site",
        value: "*me*",
        format: "text/markdown",
        name_html: "<b>Site</b>",
        value_html: "<em>me</em>",
    };
    await test.ctx.db.updateTable("accounts")
        .set({
            note: "**Hi**",
            note_format: "text/markdown",
            note_html: "<p><strong>Hi</strong></p>",
            fields: [field],
        })
        .execute();
    const row = await find(test.ctx, id);

    const account = renderAccount(test.ctx, row, [], [], []);
    assertEquals(account.note, "<p><strong>Hi</strong></p>");
    assertEquals(account.fields, [{ name: "Site", value: "<em>me</em>", verified_at: null }]);

    const own = renderCredentialAccount(test.ctx, row, [], [], [], [], 0);
    assertEquals(own.source.note, "**Hi**");
    assertEquals(own.source.fields, [{ name: "Site", value: "*me*", verified_at: null }]);
});

Deno.test("an owner sees their settings, the role everyone has, and their permissions in order", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    await test.ctx.db.updateTable("accounts")
        .set({ default_visibility: "unlisted", default_sensitive: true, default_language: "fr" })
        .execute();

    const own = CredentialAccount.parse(
        renderCredentialAccount(
            test.ctx,
            await find(test.ctx, id),
            [],
            [],
            [],
            ["roles", "owner:account", "roles"],
            0,
        ),
    );

    assertEquals(own.source.privacy, "unlisted");
    assertEquals(own.source.sensitive, true);
    assertEquals(own.source.language, "fr");
    assertEquals(own.source.quote_policy, "public");
    assertEquals(own.role.permissions, "131072");
    assertEquals(own.role.id, "-99");
    assertEquals(own.permissions, ["owner:account", "roles"]);
});

Deno.test("an account that doesn't exist isn't found", async () => {
    await using test = await createTestContext();

    assertEquals(await findAccount(test.ctx, "missing"), undefined);
});

const role = (id: string, priority: number, visible: boolean): RoleRow => ({
    id,
    name: `The ${id}s`,
    description: "",
    permissions: [],
    priority,
    visible,
    color: visible ? "#ff3838" : "",
    icon: null,
    created_at: new Date(0),
});

Deno.test("others see an account's visible roles, highest first", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    const roles = [role("admin", 100, true), role("hidden", 50, false), role("mod", 10, true)];

    const account = renderAccount(test.ctx, await find(test.ctx, id), roles, [], []);

    assertEquals(account.roles, [
        { id: "admin", name: "The admins", color: "#ff3838" },
        { id: "mod", name: "The mods", color: "#ff3838" },
    ]);
});

Deno.test("an owner sees their highest role, with everything they may do", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    const roles = [role("hidden", 100, false), role("mod", 10, true)];

    const own = CredentialAccount.parse(
        renderCredentialAccount(test.ctx, await find(test.ctx, id), roles, [], [], ["roles"], 0),
    );

    assertEquals(own.role, {
        id: "hidden",
        name: "The hiddens",
        color: "",
        permissions: "131072",
        highlighted: false,
        collection_limit: 0,
    });
    assertEquals(
        renderCredentialAccount(test.ctx, await find(test.ctx, id), [roles[1]], [], [], [], 0).role
            .highlighted,
        true,
    );
});

/** A local decoration's media, processed under `sha256` unless it says otherwise. */
const decoration = (
    kind: DecorationKind,
    position: number,
    sha256: string | null,
    media: Partial<MediaRow> = {},
): ShownDecoration => ({
    kind,
    position,
    media: {
        id: `${kind}${position}`,
        instance_id: null,
        url: null,
        media_type: "image/png",
        size: null,
        sha256,
        remote_sha256: null,
        cached_type: null,
        width: null,
        height: null,
        thumbhash: null,
        description: null,
        created_at: new Date(0),
        account_id: null,
        upload_sha256: null,
        processed_at: new Date(0),
        preview_sha256: null,
        preview_width: null,
        preview_height: null,
        blurhash: null,
        focus_x: null,
        focus_y: null,
        fit_width: null,
        fit_height: null,
        ...media,
    },
});

const decorated = [
    decoration("avatar_overlay", 1, "o1"),
    decoration("avatar_overlay", 0, "o0"),
    decoration("avatar_mask", 0, "mask"),
    decoration("background", 0, "back"),
    decoration("audio", 0, "sound"),
];

Deno.test("an account shows its pronouns, birthday, location, time zone and decorations", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    await test.ctx.db.updateTable("accounts")
        .set({
            pronouns: { en: "she/her", fr: "elle" },
            birthday: "--02-29",
            location: "Paris",
            timezone: "Europe/Paris",
        })
        .execute();

    const account = Account.parse(
        renderAccount(test.ctx, await find(test.ctx, id), [], [], decorated),
    );

    assertEquals(account.pronouns, { en: "she/her", fr: "elle" });
    assertEquals(
        [account.birthday, account.location, account.timezone],
        ["--02-29", "Paris", "Europe/Paris"],
    );
    assertEquals(account.avatar_overlays, [
        "https://social.example/media/o0",
        "https://social.example/media/o1",
    ]);
    assertEquals(
        [account.avatar_mask, account.background, account.audio],
        [
            "https://social.example/media/mask",
            "https://social.example/media/back",
            "https://social.example/media/sound",
        ],
    );

    const plain = Account.parse(renderAccount(test.ctx, await find(test.ctx, id), [], [], []));
    assertEquals(plain.avatar_overlays, []);
    assertEquals([plain.avatar_mask, plain.background, plain.audio], [null, null, null]);
});

Deno.test("a profile and an owner's account show the same decorations", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    const row = await find(test.ctx, id);

    const profile = Profile.parse(renderProfile(test.ctx, row, [], decorated));
    const own = CredentialAccount.parse(
        renderCredentialAccount(test.ctx, row, [], [], decorated, [], 0),
    );

    assertEquals(profile.avatar_overlays, own.avatar_overlays);
    assertEquals([profile.audio, profile.pronouns], ["https://social.example/media/sound", {}]);
});

Deno.test("a decoration that isn't processed, or couldn't be, is left out", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    const waiting = { processed_at: null };

    const account = Account.parse(
        renderAccount(test.ctx, await find(test.ctx, id), [], [], [
            decoration("avatar_overlay", 0, "o0", waiting),
            decoration("avatar_overlay", 1, "o1"),
            decoration("avatar_mask", 0, null),
            decoration("background", 0, null, waiting),
        ]),
    );

    assertEquals(account.avatar_overlays, ["https://social.example/media/o1"]);
    assertEquals([account.avatar_mask, account.background], [null, null]);
});

Deno.test("a suspended account shows no pronouns, birthday, location, time zone or decorations", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    await test.ctx.db.updateTable("accounts")
        .set({
            pronouns: { en: "she/her" },
            birthday: "2000-01-01",
            location: "Paris",
            timezone: "Europe/Paris",
            suspended_at: test.clock.now(),
        })
        .execute();

    const account = Account.parse(
        renderAccount(test.ctx, await find(test.ctx, id), [], [], decorated),
    );

    assertEquals(account.pronouns, {});
    assertEquals([account.birthday, account.location, account.timezone], [null, null, null]);
    assertEquals(account.avatar_overlays, []);
    assertEquals([account.avatar_mask, account.background, account.audio], [null, null, null]);
});

Deno.test("a remote account links to its own page if it gave one, and to Verso's if not", async () => {
    await using test = await createTestContext();
    const instance = await createInstance(test.ctx, "b.example");
    const insert = (id: string, username: string, url: string | null) =>
        test.ctx.db.insertInto("accounts")
            .values({
                id,
                username,
                instance_id: instance,
                remote_id: id,
                created_at: test.clock.now(),
                url,
            })
            .execute();
    await insert("r1", "bob", "https://b.example/@bob");
    await insert("r2", "carol", null);

    const bob = Account.parse(renderAccount(test.ctx, await find(test.ctx, "r1"), [], [], []));
    const carol = Account.parse(renderAccount(test.ctx, await find(test.ctx, "r2"), [], [], []));

    assertEquals(bob.url, "https://b.example/@bob");
    assertEquals(carol.url, "https://social.example/@carol@b.example");

    await test.ctx.db.updateTable("accounts").set({ suspended_at: test.clock.now() }).execute();
    const suspended = renderAccount(test.ctx, await find(test.ctx, "r1"), [], [], []);
    assertEquals(suspended.url, "https://social.example/@bob@b.example");
});
