import { assertEquals, assertFalse } from "@std/assert";
import { Instance } from "./instance.ts";

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
