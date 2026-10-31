import { assertEquals, assertFalse } from "@std/assert";
import { Context, Status } from "./status.ts";
import { Poll } from "./poll.ts";
import { account } from "./testing.ts";

/** A status as a server claiming Mastodon 4.3 sends it. */
const status = {
    id: "1",
    uri: "https://social.example/.versia/v0.6/entities/Note/1",
    created_at: "2026-01-31T12:00:00.000Z",
    account,
    content: '<p>Hi <a href="https://social.example/@bob">@bob</a> #verso</p>',
    visibility: "public",
    sensitive: false,
    spoiler_text: "",
    media_attachments: [{
        id: "2",
        type: "image",
        url: "https://cdn.example/cat.png",
        preview_url: null,
        remote_url: "https://cdn.example/cat.png",
        meta: { original: { width: 640, height: 480 } },
        description: "A cat",
        blurhash: null,
    }],
    mentions: [{
        id: "3",
        username: "bob",
        url: "https://social.example/@bob",
        acct: "bob",
    }],
    tags: [{ name: "verso", url: "https://social.example/tags/verso" }],
    emojis: [],
    reblogs_count: 0,
    favourites_count: 0,
    replies_count: 0,
    url: null,
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    reblog: null,
    poll: null,
    card: null,
    language: null,
    text: null,
    edited_at: null,
} satisfies Status;

Deno.test("a status claiming Mastodon 4.3 may leave out what came later", () => {
    assertEquals(Status.parse(status), status);
});

Deno.test("a share holds the status it shares", () => {
    const share = { ...status, id: "4", content: "", reblog: status };

    assertEquals(Status.parse(share), share);
    assertFalse(Status.safeParse({ ...status, reblog: { id: "1" } }).success);
});

Deno.test("a quote holds the status it quotes, or inside a quote, only its id", () => {
    const quoted = {
        ...status,
        quote: { state: "accepted", quoted_status_id: "5" },
        quote_approval: { automatic: ["public"], manual: [], current_user: "automatic" },
        quotes_count: 0,
    } satisfies Status;
    const quoting = {
        ...status,
        id: "6",
        quote: { state: "accepted", quoted_status: quoted },
    } satisfies Status;

    assertEquals(Status.parse(quoting), quoting);
    assertFalse(Status.safeParse({ ...status, quote: { state: "liked" } }).success);
});

Deno.test("a thread holds statuses on both sides", () => {
    const thread = { ancestors: [status], descendants: [{ ...status, id: "7" }] };

    assertEquals(Context.parse(thread), thread);
    assertFalse(Context.safeParse({ ancestors: [] }).success);
});

Deno.test("what Mastodon 4.3 had is required", () => {
    for (const key of ["reblog", "poll", "card", "edited_at", "text", "media_attachments"]) {
        const without: Record<string, unknown> = { ...status };
        delete without[key];
        assertFalse(Status.safeParse(without).success, key);
    }

    assertFalse(Status.safeParse({ ...status, poll: {} }).success);
});

Deno.test("a poll is read as Mastodon's documentation gives it", () => {
    const poll = {
        id: "34830",
        expires_at: "2019-12-05T04:05:08.302Z",
        expired: true,
        multiple: false,
        votes_count: 10,
        voters_count: null,
        voted: true,
        own_votes: [1],
        options: [{ title: "accept", votes_count: 6 }, { title: "deny", votes_count: 4 }],
        emojis: [],
    };

    assertEquals(Status.parse({ ...status, poll }).poll, poll);
    assertFalse(Poll.safeParse({ ...poll, own_votes: [-1] }).success);
});
