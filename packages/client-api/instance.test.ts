import { assertEquals, assertFalse } from "@std/assert";
import { ExtendedDescription, Instance, TermsOfService, V1Instance } from "./instance.ts";

/** An instance as a server claiming Mastodon 4.3 describes itself. */
const instance = {
    domain: "social.example",
    title: "Example Social",
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
        accounts: { max_featured_tags: 0, max_pinned_statuses: 0 },
        statuses: {
            max_characters: 500,
            max_media_attachments: 4,
            characters_reserved_per_url: 23,
        },
        media_attachments: {
            supported_mime_types: ["image/png"],
            image_size_limit: 16_777_216,
            image_matrix_limit: 33_177_600,
            video_size_limit: 103_809_024,
            video_frame_rate_limit: 120,
            video_matrix_limit: 8_294_400,
        },
        polls: {
            max_options: 4,
            max_characters_per_option: 50,
            min_expiration: 300,
            max_expiration: 2_629_746,
        },
        translation: { enabled: false },
    },
    registrations: { enabled: false, approval_required: false, message: null, url: null },
    api_versions: { mastodon: 2 },
    contact: { email: "", account: null },
    rules: [{ id: "1", text: "Be kind", hint: "" }],
} satisfies Instance;

Deno.test("an instance claiming Mastodon 4.3 may leave out what came later", () => {
    assertEquals(Instance.parse(instance), instance);
});

Deno.test("an instance may describe what later versions of Mastodon added", () => {
    const later = {
        ...instance,
        thumbnail: { ...instance.thumbnail, description: "A banner" },
        configuration: {
            ...instance.configuration,
            urls: {
                ...instance.configuration.urls,
                about: "https://social.example/about",
                privacy_policy: null,
            },
            accounts: { ...instance.configuration.accounts, max_profile_fields: 4 },
            limited_federation: false,
        },
        registrations: { ...instance.registrations, min_age: 16, reason_required: null },
        rules: [{ ...instance.rules[0], translations: { de: { text: "Sei nett", hint: "" } } }],
    } satisfies Instance;

    assertEquals(Instance.parse(later), later);
});

Deno.test("what Mastodon 4.3 had is required", () => {
    const { api_versions: _, ...withoutApiVersions } = instance;

    assertFalse(Instance.safeParse(withoutApiVersions).success);
    assertFalse(Instance.safeParse({ ...instance, rules: [{ id: "1", text: "Be kind" }] }).success);
    assertFalse(Instance.safeParse({ ...instance, contact: { account: null } }).success);
});

Deno.test("an instance may still describe itself as before Mastodon 4.0", () => {
    const v1 = {
        uri: "social.example",
        title: "Example Social",
        short_description: "A place to talk.",
        description: "<p>A place to talk.</p>",
        email: "",
        version: instance.version,
        urls: { streaming_api: "wss://social.example" },
        stats: { user_count: 1, status_count: 0, domain_count: 0 },
        thumbnail: null,
        languages: [],
        registrations: false,
        approval_required: false,
        invites_enabled: false,
        configuration: {
            accounts: { max_featured_tags: 0 },
            statuses: instance.configuration.statuses,
            media_attachments: instance.configuration.media_attachments,
            polls: instance.configuration.polls,
        },
        contact_account: null,
        rules: instance.rules,
    } satisfies V1Instance;

    assertEquals(V1Instance.parse(v1), v1);
    assertFalse(V1Instance.safeParse({ ...v1, thumbnail: undefined }).success);
    assertFalse(V1Instance.safeParse({ ...v1, stats: { user_count: 1, status_count: 0 } }).success);
});

Deno.test("policies have a date and HTML", () => {
    for (const updated_at of ["2022-11-03T04:09:07Z", "2022-10-07T00:00:00+00:00"]) {
        const description = { updated_at, content: "<p>Hi</p>" };
        assertEquals(ExtendedDescription.parse(description), description);
    }
    assertFalse(ExtendedDescription.safeParse({ updated_at: "2022-10-07", content: "" }).success);

    const terms = {
        effective_date: "2025-04-15",
        effective: true,
        content: "<p>Be kind</p>",
        succeeded_by: null,
    };
    assertEquals(TermsOfService.parse(terms), terms);
    assertEquals(
        TermsOfService.parse({ ...terms, succeeded_by: "2026-01-01" }).succeeded_by,
        "2026-01-01",
    );
    assertFalse(
        TermsOfService.safeParse({ ...terms, effective_date: "2025-04-15T00:00:00Z" }).success,
    );
    assertFalse(TermsOfService.safeParse({ ...terms, succeeded_by: undefined }).success);
});
