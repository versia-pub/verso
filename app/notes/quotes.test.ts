import { assertEquals, assertStringIncludes } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { queuedDeliveries } from "../federation/testing.ts";
import { block } from "../graph/blocks.ts";
import { blockDomainFor } from "../graph/domain_blocks.ts";
import { follow } from "../graph/follows.ts";
import { mute } from "../graph/mutes.ts";
import { createInstance, defaultSettings } from "../instances/testing.ts";
import { share } from "../interactions/shares.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { findNote } from "./note_queries.ts";
import { noteRoutes } from "./routes.ts";
import { removeNote } from "./removal.ts";
import { createNote, createShare } from "./testing.ts";

/** alice, bob, who follows her, carol and dave, who don't, and frank, on d.example. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, noteRoutes(defaultSettings().limits), {
        checkResponses: true,
    });
    for (const id of ["alice", "bob", "carol", "dave"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "bob", "alice");
    await createInstance(test.ctx, "d.example");
    await createRemoteAccount(test.ctx, "frank", "d.example");

    /** Sends a request as `as`, or as nobody if it is `null`, with `body` in JSON if given. */
    const request = async (
        method: string,
        path: string,
        as: string | null = "bob",
        body?: Record<string, unknown>,
    ) => {
        const response = await app.request(path, {
            method,
            headers: {
                ...as === null ? {} : { authorization: `Bearer ${await tokenFor(test.ctx, as)}` },
                "content-type": "application/json",
            },
            body: body && JSON.stringify(body),
        });

        return {
            status: response.status,
            body: await response.json(),
            link: response.headers.get("link"),
        };
    };

    /** Posts a status as `as` that quotes `quoted`. */
    const quote = (quoted: string, as = "bob", body: Record<string, unknown> = {}) =>
        request("POST", "/api/v1/statuses", as, { status: "", quoted_status_id: quoted, ...body });

    /** The domains Verso queued deliveries to, of entities of `type`. */
    const delivered = async (type: string) => {
        return (await queuedDeliveries(test.ctx))
            .filter((job) => JSON.parse(job.body).type === type)
            .map((job) => job.domain).toSorted();
    };

    return { ...test, request, quote, delivered };
};

Deno.test("a status quotes another, even with no text, and the quote shows it", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", { content_html: "<p>Original</p>" });

    const posted = await test.quote(note.id);
    assertEquals(posted.status, 200);
    assertEquals(posted.body.content, "");
    assertEquals(posted.body.quote.state, "accepted");
    assertEquals(posted.body.quote.quoted_status.id, note.id);
    assertEquals(posted.body.quote.quoted_status.content, "<p>Original</p>");
    assertEquals(posted.body.quotes_count, 0);
    assertEquals((await findNote(test.ctx, posted.body.id))?.quote_id, note.id);

    const quoted = await test.request("GET", `/api/v1/statuses/${note.id}`, null);
    assertEquals([quoted.body.quotes_count, quoted.body.quote], [1, null]);

    // The same for anyone, and when the quote is looked up again.
    const again = await test.request("GET", `/api/v1/statuses/${posted.body.id}`, "dave");
    assertEquals(again.body.quote.quoted_status.id, note.id);
});

Deno.test("a quote inside a quote is given by id", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const first = await test.quote(note.id);
    const second = await test.quote(first.body.id, "carol");

    const inner = second.body.quote.quoted_status;
    assertEquals(inner.id, first.body.id);
    assertEquals(inner.quote, { state: "accepted", quoted_status_id: note.id });
    assertEquals(inner.quotes_count, 1);
});

Deno.test("quoting a boost quotes the status it boosts", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const boost = await createShare(test.ctx, "dave", note.id);

    const posted = await test.quote(boost.id, "carol", { status: "Look" });
    assertEquals(posted.body.quote.quoted_status.id, note.id);
    assertEquals(posted.body.content, "<p>Look</p>");
});

Deno.test("a status can't be quoted if it is missing, direct, or not the quoter's to see", async () => {
    await using test = await open();
    const direct = await createNote(test.ctx, "alice", { visibility: "direct" }, ["bob"]);
    const priv = await createNote(test.ctx, "alice", { visibility: "private" });

    for (const id of ["missing", direct.id, priv.id]) {
        const refused = await test.quote(id);
        assertEquals([id, refused.status], [id, 404]);
        assertEquals(
            refused.body.error_description,
            "The post you are trying to quote does not appear to exist.",
        );
    }
    assertEquals((await test.quote(priv.id, "carol")).status, 404);
    assertEquals((await test.quote(direct.id, "alice")).status, 404);
    assertEquals(
        (await test.request("POST", "/api/v1/statuses", "bob", { status: "" })).status,
        422,
    );
});

Deno.test("a private status is quoted by its author alone, and the quote is private", async () => {
    await using test = await open();
    const priv = await createNote(test.ctx, "alice", { visibility: "private" });

    const posted = await test.quote(priv.id, "alice", { visibility: "public" });
    assertEquals([posted.status, posted.body.visibility], [200, "private"]);
    assertEquals(posted.body.quote.quoted_status.id, priv.id);

    const unlisted = await test.quote(priv.id, "alice", { visibility: "unlisted" });
    assertEquals(unlisted.body.visibility, "private");
    const direct = await test.quote(priv.id, "alice", { visibility: "direct" });
    assertEquals(direct.body.visibility, "direct");

    // Not the author's followers, though they see it.
    const note = await test.request("GET", `/api/v1/statuses/${priv.id}`, "bob");
    assertEquals(note.body.quote_approval, { automatic: [], manual: [], current_user: "denied" });
});

Deno.test("a quote that is direct names the quoted author, unless it is their own", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const own = await createNote(test.ctx, "bob");

    const refused = await test.quote(note.id, "bob", { visibility: "direct" });
    assertEquals(refused.status, 422);
    assertEquals(
        refused.body.error_description,
        "Cannot quote a non-mentioned user in a Private Mention post.",
    );
    const mentioned = await test.quote(note.id, "bob", { visibility: "direct", status: "@alice" });
    assertEquals([mentioned.status, mentioned.body.visibility], [200, "direct"]);
    assertEquals((await test.quote(own.id, "bob", { visibility: "direct" })).status, 200);
});

Deno.test("a user who blocks an author can't quote them, and the author blocking the quoter doesn't show", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const remote = await createNote(test.ctx, "frank", {
        instance_id: "d.example",
        remote_id: "f",
    });

    await block(test.ctx, "bob", "alice");
    assertEquals((await test.quote(note.id, "bob")).status, 404);
    assertEquals((await test.quote(note.id, "carol")).status, 200);
    await block(test.ctx, "alice", "dave");
    assertEquals((await test.quote(note.id, "dave")).status, 200);

    assertEquals((await test.quote(remote.id, "carol")).status, 200);
    await blockDomainFor(test.ctx, "carol", "d.example");
    assertEquals((await test.quote(remote.id, "carol")).status, 404);
    // Another account's block of the domain doesn't matter.
    assertEquals((await test.quote(remote.id, "dave")).status, 200);
});

Deno.test("who may quote a status is given as Mastodon does, and what a viewer may do", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const everyone = { automatic: ["public"], manual: [] };
    const path = `/api/v1/statuses/${note.id}`;

    assertEquals((await test.request("GET", path, null)).body.quote_approval, {
        ...everyone,
        current_user: "denied",
    });
    assertEquals((await test.request("GET", path, "dave")).body.quote_approval, {
        ...everyone,
        current_user: "automatic",
    });

    const direct = await createNote(test.ctx, "alice", { visibility: "direct" }, ["bob"]);
    assertEquals(
        (await test.request("GET", `/api/v1/statuses/${direct.id}`, "alice")).body.quote_approval,
        { automatic: [], manual: [], current_user: "denied" },
    );

    const priv = await createNote(test.ctx, "alice", { visibility: "private" });
    assertEquals(
        (await test.request("GET", `/api/v1/statuses/${priv.id}`, "alice")).body.quote_approval
            .current_user,
        "automatic",
    );

    // A boost shows the policy of what it boosts.
    const boost = await createShare(test.ctx, "dave", note.id);
    assertEquals(
        (await test.request("GET", `/api/v1/statuses/${boost.id}`, "bob")).body
            .quote_approval,
        { ...everyone, current_user: "automatic" },
    );

    // Whatever the visibility of the boost itself.
    const private_boost = await createShare(test.ctx, "carol", note.id, { visibility: "private" });
    assertEquals(
        (await test.request("GET", `/api/v1/statuses/${private_boost.id}`, "carol")).body
            .quote_approval,
        { ...everyone, current_user: "automatic" },
    );

    // An unlisted status may be quoted by anyone, like a public one.
    const unlisted = await createNote(test.ctx, "alice", { visibility: "unlisted" });
    assertEquals(
        (await test.request("GET", `/api/v1/statuses/${unlisted.id}`, "dave")).body
            .quote_approval,
        { ...everyone, current_user: "automatic" },
    );
    assertEquals((await test.quote(unlisted.id, "dave")).status, 200);
});

Deno.test("a quote shows why its status is hidden from a viewer, and what they may see", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const remote = await createNote(test.ctx, "frank", {
        instance_id: "d.example",
        remote_id: "f",
    });
    const quotes = {
        note: (await test.quote(note.id, "bob")).body.id,
        remote: (await test.quote(remote.id, "bob")).body.id,
    };
    const seen = async (id: string, as: string | null) =>
        (await test.request("GET", `/api/v1/statuses/${id}`, as)).body.quote;

    assertEquals((await seen(quotes.note, "dave")).state, "accepted");
    assertEquals((await seen(quotes.note, null)).state, "accepted");

    await block(test.ctx, "dave", "alice");
    const blocked = await seen(quotes.note, "dave");
    assertEquals([blocked.state, blocked.quoted_status.id], ["blocked_account", note.id]);

    await blockDomainFor(test.ctx, "carol", "d.example");
    const domain = await seen(quotes.remote, "carol");
    assertEquals([domain.state, domain.quoted_status.id], ["blocked_domain", remote.id]);
    assertEquals((await seen(quotes.remote, "dave")).state, "accepted");

    await mute(test.ctx, "carol", "alice", { notifications: true, duration: 0 });
    assertEquals((await seen(quotes.note, "carol")).state, "muted_account");

    // The quoted status is private now, and carol doesn't follow alice.
    await test.ctx.db.updateTable("notes").set({ visibility: "private" })
        .where("id", "=", note.id).execute();
    assertEquals(await seen(quotes.note, "carol"), { state: "unauthorized", quoted_status: null });
    assertEquals(await seen(quotes.note, null), { state: "unauthorized", quoted_status: null });
    assertEquals((await seen(quotes.note, "alice")).state, "accepted");
    assertEquals((await seen(quotes.note, "bob")).quoted_status.id, note.id);

    // Inside a quote, a hidden quote is by id as well.
    const outer = await test.quote(quotes.note, "bob");
    const inner = (await seen(outer.body.id, "carol")).quoted_status.quote;
    assertEquals(inner, { state: "unauthorized", quoted_status_id: null });
});

Deno.test("a status whose quoted status is deleted has no quote", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const posted = await test.quote(note.id);

    await removeNote(test.ctx, note.id);
    const after = await test.request("GET", `/api/v1/statuses/${posted.body.id}`, null);
    assertEquals(after.body.quote, null);
});

Deno.test("the quotes of a status are listed, as those the viewer may see and hasn't hidden", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const bob = (await test.quote(note.id, "bob")).body.id;
    const carol = (await test.quote(note.id, "carol")).body.id;
    const dave = (await test.quote(note.id, "dave", { visibility: "private" })).body.id;
    const direct = (await test.quote(note.id, "bob", { visibility: "direct", status: "@alice" }))
        .body.id;
    await createShare(test.ctx, "dave", bob);
    // So alice sees dave's private quote.
    await follow(test.ctx, "alice", "dave");
    const path = `/api/v1/statuses/${note.id}/quotes`;
    const ids = (response: { body: { id: string }[] }) => response.body.map((s) => s.id);

    assertEquals(ids(await test.request("GET", path, null)), [carol, bob]);
    assertEquals(ids(await test.request("GET", path, "alice")), [direct, dave, carol, bob]);
    assertEquals(ids(await test.request("GET", path, "dave")), [dave, carol, bob]);
    assertEquals(ids(await test.request("GET", path, "carol")), [carol, bob]);

    await mute(test.ctx, "alice", "carol", { notifications: false, duration: 0 });
    await block(test.ctx, "alice", "bob");
    assertEquals(ids(await test.request("GET", path, "alice")), [dave]);

    const page = await test.request("GET", `${path}?limit=1`, null);
    assertEquals(ids(page), [carol]);
    assertStringIncludes(page.link ?? "", `max_id=${carol}`);
    assertEquals(ids(await test.request("GET", `${path}?limit=1&max_id=${carol}`, null)), [bob]);

    // Of a boost, the quotes of the status it boosts, not those of one the viewer can't see.
    const boost = await createShare(test.ctx, "dave", note.id);
    assertEquals(ids(await test.request("GET", `/api/v1/statuses/${boost.id}/quotes`, null)), [
        carol,
        bob,
    ]);
    assertEquals((await test.request("GET", "/api/v1/statuses/missing/quotes", null)).status, 404);
    const priv = await createNote(test.ctx, "alice", { visibility: "private" });
    assertEquals(
        (await test.request("GET", `/api/v1/statuses/${priv.id}/quotes`, "dave")).status,
        404,
    );
});

Deno.test("the quotes of a status are counted by what anyone can see", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    await test.quote(note.id, "bob");
    await test.quote(note.id, "carol", { visibility: "unlisted" });
    await test.quote(note.id, "carol", { visibility: "private" });
    await test.quote(note.id, "carol", { visibility: "direct", status: "@alice" });
    await share(test.ctx, "dave", note.id);

    const shown = await test.request("GET", `/api/v1/statuses/${note.id}`, null);
    assertEquals(shown.body.quotes_count, 2);
});

Deno.test("a quote can't be revoked, since none is up for review", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const other = await createNote(test.ctx, "carol");
    const posted = await test.quote(note.id);
    const path = (id: string, quote: string) => `/api/v1/statuses/${id}/quotes/${quote}/revoke`;

    const refused = await test.request("POST", path(note.id, posted.body.id), "alice");
    assertEquals(refused.status, 403);
    assertEquals((await test.request("POST", path(note.id, other.id), "alice")).status, 404);
    assertEquals(
        (await test.request("POST", path("missing", posted.body.id), "alice")).status,
        404,
    );
    assertEquals((await test.request("POST", path(note.id, "missing"), "alice")).status, 404);
    assertEquals((await findNote(test.ctx, posted.body.id))?.quote_id, note.id);
});

Deno.test("editing a quote keeps it, and a quote policy is accepted and ignored", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const posted = await test.quote(note.id, "bob", {
        status: "Look",
        quote_approval_policy: "nobody",
    });
    assertEquals(posted.status, 200);
    assertEquals(posted.body.quote_approval.current_user, "automatic");

    const edited = await test.request("PUT", `/api/v1/statuses/${posted.body.id}`, "bob", {
        status: "Look again",
        quoted_status_id: "other",
        quote_approval_policy: "followers",
    });
    assertEquals([edited.status, edited.body.quote.quoted_status.id], [200, note.id]);

    const invalid = await test.request("POST", "/api/v1/statuses", "bob", {
        status: "Hi",
        quote_approval_policy: "everyone",
    });
    assertEquals(invalid.status, 422);
});

Deno.test("a quote is sent to the instance of the quoted author, and so is its deletion", async () => {
    await using test = await open();
    const remote = await createNote(test.ctx, "frank", {
        instance_id: "d.example",
        remote_id: "f",
    });

    const posted = await test.quote(remote.id, "alice");
    assertEquals(await test.delivered("Note"), ["d.example"]);
    const [sent] = await queuedDeliveries(test.ctx);
    assertEquals(JSON.parse(sent.body).quotes, "d.example:f");

    await removeNote(test.ctx, posted.body.id);
    assertEquals(await test.delivered("Delete"), ["d.example"]);
});
