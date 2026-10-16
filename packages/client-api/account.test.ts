import { assertEquals, assertFalse } from "@std/assert";
import { Account, CredentialAccount } from "./account.ts";

const account = {
    id: "1",
    username: "alice",
    acct: "alice",
    url: "https://social.example/@alice",
    uri: "https://social.example/.versia/v0.6/entities/User/1",
    display_name: "Alice",
    note: "<p>Hi</p>",
    avatar: "https://social.example/accounts/1/avatar.png",
    avatar_static: "https://social.example/accounts/1/avatar.png",
    avatar_description: "",
    header: "https://social.example/accounts/1/header.png",
    header_static: "https://social.example/accounts/1/header.png",
    header_description: "",
    locked: false,
    fields: [{ name: "Website", value: "example.com", verified_at: null }],
    emojis: [],
    bot: false,
    group: false,
    discoverable: true,
    indexable: true,
    created_at: "2026-01-31T00:00:00.000Z",
    last_status_at: null,
    statuses_count: 0,
    followers_count: 0,
    following_count: 0,
    hide_collections: false,
    show_media: true,
    show_media_replies: true,
    show_featured: true,
    roles: [],
    feature_approval: { automatic: [], manual: [], current_user: "denied" },
} satisfies Account;

Deno.test("an account that moved shows the account it moved to", () => {
    const moved = { ...account, id: "2", moved: account };

    assertEquals(Account.parse(moved), moved);
    assertFalse(Account.safeParse({ ...account, moved: { id: "1" } }).success);
});

Deno.test("an account's own view adds its settings and role", () => {
    const own = {
        ...account,
        source: {
            note: "Hi",
            fields: account.fields,
            privacy: "public",
            sensitive: false,
            language: "",
            follow_requests_count: 0,
            hide_collections: false,
            discoverable: true,
            indexable: true,
            attribution_domains: [],
            quote_policy: "public",
        },
        role: {
            id: "-99",
            name: "",
            color: "",
            permissions: "0",
            highlighted: false,
            collection_limit: 0,
        },
    } satisfies CredentialAccount;

    assertEquals(CredentialAccount.parse(own), own);
    const { source: _, ...withoutSource } = own;
    const { role: __, ...withoutRole } = own;
    assertFalse(CredentialAccount.safeParse(withoutSource).success);
    assertFalse(CredentialAccount.safeParse(withoutRole).success);
});

Deno.test("dates are as Mastodon sends them", () => {
    assertFalse(Account.safeParse({ ...account, created_at: "2026-01-31" }).success);
    assertFalse(
        Account.safeParse({ ...account, last_status_at: "2026-01-31T00:00:00Z" }).success,
    );
    assertEquals(
        Account.parse({ ...account, last_status_at: "2026-01-31" }).last_status_at,
        "2026-01-31",
    );
});
