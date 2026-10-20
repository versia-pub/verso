import { assertEquals } from "@std/assert";
import { importPublicKey, sign, v0_6, verify } from "@versia/protocol";
import { instanceKey } from "../instances/keys.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { createNetwork } from "../testing/network.ts";
import { remoteAccountOf } from "./federation.ts";
import { updateProfile } from "./profile.ts";
import { createLocalAccount } from "./testing.ts";

/**
 * Fetches `path` from `to` as `from` would, signing the request, and checks that the reply is
 * signed by `to`.
 */
const fetchSigned = async (from: Context, to: Context, path: string) => {
    // The query isn't signed.
    const { pathname } = new URL(path, to.urls.origin);
    const headers = await sign(
        { method: "GET", pathname, body: new Uint8Array() },
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
    const signature = await verify(
        { method: "GET", pathname, body },
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

    assertEquals(await fetchSigned(b, a, "/.versia/v0.6/entities/User/alice"), {
        status: 200,
        type: "application/vnd.versia+json; charset=utf-8",
        signedBy: "a.test",
        body: {
            type: "User",
            id: "alice",
            created_at: a.clock.now().toISOString(),
            username: "alice",
            display_name: "Alice",
            bio: {
                "text/plain": { content: "Hi <there>", remote: false },
                "text/html": { content: "<p>Hi &lt;there&gt;</p>", remote: false },
            },
            fields: [{
                key: {
                    "text/plain": { content: "Site & more", remote: false },
                    "text/html": { content: "Site &amp; more", remote: false },
                },
                value: {
                    "text/plain": { content: "a & b", remote: false },
                    "text/html": { content: "a &amp; b", remote: false },
                },
            }],
            avatar: {
                "image/png": { content: "https://a.test/accounts/alice/avatar.png", remote: true },
            },
            header: {
                "image/png": { content: "https://a.test/accounts/alice/header.png", remote: true },
            },
            manually_approves_followers: true,
            indexable: true,
        },
    });
});

Deno.test("a user without a name or bio leaves them out", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    await createLocalAccount(a, "bob");

    const { body } = await fetchSigned(
        network.instances["b.test"].ctx,
        a,
        "/.versia/v0.6/entities/User/bob",
    );

    assertEquals(
        [
            body.display_name,
            body.bio,
            body.fields,
            body.manually_approves_followers,
            body.indexable,
        ],
        [undefined, undefined, [], false, false],
    );
});

Deno.test("text is given in the format its owner wrote it in", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    await createLocalAccount(a, "alice");
    await a.db.updateTable("accounts")
        .set({ note: "**Hi**", note_format: "text/markdown", note_html: "<p><b>Hi</b></p>" })
        .execute();

    const { body } = await fetchSigned(
        network.instances["b.test"].ctx,
        a,
        "/.versia/v0.6/entities/User/alice",
    );

    assertEquals(body.bio, {
        "text/markdown": { content: "**Hi**", remote: false },
        "text/html": { content: "<p><b>Hi</b></p>", remote: false },
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
        new Request("https://a.test/.versia/v0.6/entities/User/alice"),
    );
    assertEquals(unsigned.status, 401);
    for (const id of ["remote", "missing"]) {
        assertEquals(
            (await fetchSigned(b, a, `/.versia/v0.6/entities/User/${id}`)).status,
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
    const collection = (path: string) => fetchSigned(b, a, `/.versia/v0.6/entities/User/${path}`);

    for (const name of ["outbox", "featured"]) {
        assertEquals(await collection(`alice/collections/${name}?offset=10&limit=20`), {
            status: 200,
            type: "application/vnd.versia+json; charset=utf-8",
            signedBy: "a.test",
            body: { author: "alice", total: 0, items: [] },
        }, name);
    }

    assertEquals((await collection("alice/collections/likes")).status, 404);
    assertEquals((await collection("missing/collections/outbox")).status, 404);
    for (const query of ["offset=-1", "offset=a", "limit=1.5"]) {
        assertEquals((await collection(`alice/collections/outbox?${query}`)).status, 422, query);
    }

    const unsigned = await b.transport(
        new Request("https://a.test/.versia/v0.6/entities/User/alice/collections/outbox"),
    );
    assertEquals(unsigned.status, 401);
});

const user = (changes: Partial<v0_6.User> = {}): v0_6.User => ({
    type: "User",
    id: "abc",
    created_at: "2026-01-01T00:00:00Z",
    username: "bob",
    fields: [],
    manually_approves_followers: false,
    indexable: true,
    ...changes,
});

Deno.test("a remote user becomes an account, with its text as written and as HTML", () => {
    const account = remoteAccountOf(
        "b.test",
        user({
            display_name: "Bob",
            bio: {
                "text/plain": { content: "Hi there", remote: false },
                "text/html": { content: "<p>Hi <b>there</b></p>", remote: false },
            },
            fields: [{
                key: { "text/plain": { content: "Site", remote: false } },
                value: {
                    "text/plain": { content: "b.test", remote: false },
                    "text/html": { content: '<a href="https://b.test">b.test</a>', remote: false },
                },
            }],
            manually_approves_followers: true,
        }),
    );

    assertEquals(account, {
        instanceId: "b.test",
        remoteId: "abc",
        createdAt: new Date("2026-01-01T00:00:00Z"),
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
                value_html: '<a href="https://b.test">b.test</a>',
            }],
            locked: true,
            indexable: true,
        },
        avatar: null,
        header: null,
    });
});

Deno.test("remote text without HTML is escaped, and HTML alone is kept", () => {
    const markdown = remoteAccountOf(
        "b.test",
        user({
            bio: { "text/markdown": { content: "**Hi** <there>", remote: false } },
        }),
    );
    assertEquals(
        [markdown.profile.note, markdown.profile.note_format, markdown.profile.note_html],
        ["**Hi** <there>", "text/markdown", "<p>**Hi** &lt;there&gt;</p>"],
    );

    const html = remoteAccountOf(
        "b.test",
        user({
            bio: {
                "text/html": { content: "<p>Hi</p>", remote: false },
                "text/plain": { content: "https://b.test/bio.txt", remote: true },
            },
        }),
    );
    assertEquals(
        [html.profile.note, html.profile.note_format, html.profile.note_html],
        ["", "text/plain", "<p>Hi</p>"],
    );

    const none = remoteAccountOf("b.test", user());
    assertEquals([none.profile.display_name, none.profile.note_html], ["", ""]);
});

Deno.test("a remote picture is the first version clients can show, at a web address", () => {
    const account = remoteAccountOf(
        "b.test",
        user({
            avatar: {
                "image/x-icon": { content: "https://b.test/bob.ico", remote: true },
                "image/png": { content: "javascript:alert(1)", remote: true },
                "image/jpeg": { content: "data", remote: false },
                "image/webp": {
                    content: "https://b.test/bob.webp",
                    remote: true,
                    size: 1234,
                    hash: "AB".repeat(32),
                    width: 64,
                    height: 48,
                    thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
                    description: "Bob",
                },
            },
            header: { "image/svg+xml": { content: "https://b.test/sea.svg", remote: true } },
        }),
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
