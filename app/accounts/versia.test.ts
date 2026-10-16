import { assertEquals } from "@std/assert";
import { importPublicKey, sign, verify } from "@versia/protocol";
import { instanceKey } from "../instances/keys.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { createNetwork } from "../testing/network.ts";
import { updateProfile } from "./profile.ts";
import { createLocalAccount } from "./testing.ts";

/**
 * Fetches `path` from `to` as `from` would, signing the request, and checks that the reply is
 * signed by `to`.
 */
const fetchSigned = async (from: Context, to: Context, path: string) => {
    const domain = (ctx: Context) => new URL(ctx.urls.origin).hostname;
    const headers = await sign(
        { method: "GET", pathname: path, body: new Uint8Array() },
        (await instanceKey(from)).privateKey,
        domain(from),
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
        { method: "GET", pathname: path, body },
        response.headers,
        (signer) => Promise.resolve(signer === domain(to) ? theirs : undefined),
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
