import { assertEquals } from "@std/assert";
import { tokenFor } from "../auth/testing.ts";
import { identiconBanner } from "../accounts/identicon.ts";
import { createLocalAccount, createRole, giveRole } from "../accounts/testing.ts";
import { createApp } from "../http/app.ts";
import { parseConfig } from "../kernel/config.ts";
import { createTestContext } from "../kernel/testing.ts";
import { type AboutSettings, instanceRoutes } from "./routes.ts";
import { createInstance, defaultSettings } from "./testing.ts";

const open = async (settings: AboutSettings = defaultSettings()) => {
    const test = await createTestContext();
    const app = createApp(test.ctx, instanceRoutes(settings), { checkResponses: true });

    const get = async () => (await app.request("/api/v2/instance")).json();

    return { ...test, app, get };
};

/** Settings from a config file, after the minimal parts every config has. */
const configured = async (toml: string): Promise<AboutSettings> => {
    const result = await parseConfig(
        `domain = "social.example"\ndatabase = { sqlite = "v.db" }\n${toml}`,
    );
    if (!result.ok) throw new Error(result.error);

    return result.config;
};

Deno.test("an instance with no settings goes by its domain, and claims Mastodon 4.3", async () => {
    await using test = await open();

    assertEquals(await test.get(), {
        domain: "social.example",
        title: "social.example",
        version: "4.3.0 (compatible; Verso 0.0.0)",
        source_url: "https://github.com/versia-pub/verso",
        description: "",
        usage: { users: { active_month: 0 } },
        thumbnail: { url: "https://social.example/instance/thumbnail.png" },
        icon: [],
        languages: [],
        configuration: {
            urls: { streaming: "wss://social.example" },
            vapid: { public_key: "" },
            accounts: {
                max_featured_tags: 0,
                max_pinned_statuses: 0,
                max_display_name_length: 60,
                max_note_length: 10_000,
                max_profile_fields: 16,
                profile_field_name_limit: 255,
                profile_field_value_limit: 255,
            },
            statuses: {
                max_characters: 0,
                max_media_attachments: 0,
                characters_reserved_per_url: 23,
            },
            media_attachments: {
                supported_mime_types: [],
                image_size_limit: 0,
                image_matrix_limit: 0,
                video_size_limit: 0,
                video_frame_rate_limit: 0,
                video_matrix_limit: 0,
            },
            polls: {
                max_options: 0,
                max_characters_per_option: 0,
                min_expiration: 0,
                max_expiration: 0,
            },
            translation: { enabled: false },
        },
        registrations: {
            enabled: false,
            approval_required: false,
            message: "<p>This instance isn&#39;t taking new accounts.</p>",
            url: null,
        },
        api_versions: { mastodon: 2 },
        contact: { email: "", account: null },
        rules: [],
    });
});

Deno.test("an instance describes itself as configured", async () => {
    const settings = await configured(`
[instance]
name = "Example Social"
description = "A place to talk."
contact = { email = "admin@social.example", account = "ALICE" }

[[instance.rules]]
text = "Be kind"

[[instance.rules]]
text = "No spam"
hint = "Ads included"

[limits]
fields = 4

[[auth.issuers]]
name = "Closed ID"
url = "https://closed.example"
client_id = "verso"
client_secret = "s"

[[auth.issuers]]
name = "Open & Free ID"
url = "https://open.example"
client_id = "verso"
client_secret = "s"
registration = "open"

[[auth.issuers]]
name = "Partner ID"
url = "https://partner.example"
client_id = "verso"
client_secret = "s"
registration = { claim = "groups", contains = "verso" }
`);
    await using test = await open(settings);
    await createLocalAccount(test.ctx, "alice");
    await createRole(test.ctx, "Admin", []);
    await test.ctx.db.updateTable("roles").set({ visible: true }).execute();
    await giveRole(test.ctx, "alice", "Admin");

    const instance = await test.get();

    assertEquals(instance.title, "Example Social");
    assertEquals(instance.description, "A place to talk.");
    assertEquals(instance.configuration.accounts.max_profile_fields, 4);
    assertEquals(
        instance.registrations.message,
        "<p>New accounts are made by logging in with Open &amp; Free ID or Partner ID.</p>",
    );
    assertEquals(instance.contact.email, "admin@social.example");
    assertEquals(
        [instance.contact.account.username, instance.contact.account.roles],
        ["alice", [{ id: "Admin", name: "Admin", color: "" }]],
    );
    assertEquals(instance.rules, [
        { id: "1", text: "Be kind", hint: "" },
        { id: "2", text: "No spam", hint: "Ads included" },
    ]);
});

Deno.test("a contact account that doesn't exist is left out", async () => {
    await using test = await open(await configured('[instance]\ncontact = { account = "nobody" }'));

    assertEquals((await test.get()).contact, { email: "", account: null });
});

Deno.test("active users are local accounts that logged in within four weeks", async () => {
    await using test = await open();
    const day = 24 * 60 * 60 * 1000;
    for (const username of ["alice", "bob", "carol", "dave"]) {
        await createLocalAccount(test.ctx, username);
    }

    await test.ctx.db.insertInto("accounts")
        .values({
            id: "remote",
            username: "erin",
            instance_id: await createInstance(test.ctx, "b.example"),
            remote_id: "erin",
            created_at: test.ctx.clock.now(),
        })
        .execute();

    await tokenFor(test.ctx, "alice");
    await tokenFor(test.ctx, "bob");
    await tokenFor(test.ctx, "remote");
    test.clock.advance(day);
    await tokenFor(test.ctx, "carol");
    await tokenFor(test.ctx, "carol");
    await tokenFor(test.ctx, null);
    test.clock.advance(27 * day);

    assertEquals((await test.get()).usage.users.active_month, 3);

    test.clock.advance(1);
    assertEquals((await test.get()).usage.users.active_month, 1);
});

Deno.test("the thumbnail is the domain's banner, which anyone may cache for a day", async () => {
    await using test = await open();

    const response = await test.app.request("/instance/thumbnail.png");

    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "image/png");
    assertEquals(response.headers.get("cache-control"), "public, max-age=86400");
    assertEquals(
        new Uint8Array(await response.arrayBuffer()),
        await identiconBanner("social.example"),
    );
});
