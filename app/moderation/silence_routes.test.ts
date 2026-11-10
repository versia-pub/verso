/**
 * What local users see of a silenced account through the client API: all of it, said to be
 * limited, but none of its statuses on the public timelines, as on Mastodon.
 * @module
 */
import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { follow } from "../graph/follows.ts";
import { routes } from "../http/routes.ts";
import { defaultSettings } from "../instances/testing.ts";
import { postNote } from "../notes/notes.ts";
import { createNote } from "../notes/testing.ts";
import { indexUnindexedAccounts } from "../search/accounts.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { silence, unsilence } from "./silences.ts";

Deno.test("a silenced account is said to be limited, and its statuses kept off the public timelines", async () => {
    await using test = await createTestContext();
    const app = createTestApp(test.ctx, routes(defaultSettings()), { checkResponses: true });
    for (const id of ["alice", "carol"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "alice", "carol");
    for (const [id, text] of [["alice", "#cats"], ["carol", "#cats"]]) {
        await postNote(test.ctx, id, { format: "text/plain", spoilerText: "", text });
    }
    await indexUnindexedAccounts(test.ctx);
    const token = await tokenFor(test.ctx, "alice");

    /** What alice is shown of carol, and who wrote the statuses at each path. */
    const shown = async () => {
        const get = async (path: string) =>
            await (await app.request(path, { headers: { authorization: `Bearer ${token}` } }))
                .json();
        const authors = async (path: string) =>
            ((await get(path)) as { account: { id: string } }[])
                .map((status) => status.account.id).toSorted();
        const account = await get("/api/v1/accounts/carol");

        return {
            limited: account.limited,
            username: account.username,
            public: await authors("/api/v1/timelines/public"),
            tag: await authors("/api/v1/timelines/tag/cats"),
            home: await authors("/api/v1/timelines/home"),
            statuses: await authors("/api/v1/accounts/carol/statuses"),
            search: ((await get("/api/v2/search?q=caro&type=accounts")) as {
                accounts: { id: string }[];
            }).accounts.map((each) => each.id),
        };
    };

    const before = await shown();
    assertEquals(before, {
        limited: undefined,
        username: "carol",
        public: ["alice", "carol"],
        tag: ["alice", "carol"],
        home: ["alice", "carol"],
        statuses: ["carol"],
        search: ["carol"],
    });

    // Even to those who follow it, as on Mastodon.
    await silence(test.ctx, "carol");
    assertEquals(await shown(), {
        ...before,
        limited: true,
        public: ["alice"],
        tag: ["alice"],
    });

    await unsilence(test.ctx, "carol");
    assertEquals(await shown(), before);
});

Deno.test("a silenced account's statuses are left out of threads and quotes for those who don't follow it", async () => {
    await using test = await createTestContext();
    const app = createTestApp(test.ctx, routes(defaultSettings()), { checkResponses: true });
    for (const id of ["alice", "bob", "carol", "dan"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "bob", "carol");
    const root = await createNote(test.ctx, "dan");
    const middle = await createNote(test.ctx, "carol", { in_reply_to_id: root.id });
    const leaf = await createNote(test.ctx, "dan", { in_reply_to_id: middle.id });
    const quoting = await createNote(test.ctx, "carol", { quote_id: root.id });
    const quoted = await createNote(test.ctx, "dan", { quote_id: middle.id });
    const tokens = new Map<string, string>();
    for (const id of ["alice", "bob", "carol", "dan"]) {
        tokens.set(id, await tokenFor(test.ctx, id));
    }

    /** What `viewerId`, or anyone if it is `null`, is shown around carol's statuses. */
    const shown = async (viewerId: string | null) => {
        const get = async (path: string) => {
            const token = viewerId === null ? undefined : tokens.get(viewerId);
            const response = await app.request(path, {
                headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
            });
            return { status: response.status, body: await response.json() };
        };
        const ids = (statuses: { id: string }[]) => statuses.map((status) => status.id);
        const above = (await get(`/api/v1/statuses/${leaf.id}/context`)).body;
        const below = (await get(`/api/v1/statuses/${root.id}/context`)).body;
        const quote = (await get(`/api/v1/statuses/${quoted.id}`)).body.quote;

        return {
            status: (await get(`/api/v1/statuses/${middle.id}`)).status,
            middle: ids((await get(`/api/v1/statuses/${middle.id}/context`)).body.descendants),
            ancestors: ids(above.ancestors),
            descendants: ids(below.descendants),
            quotes: ids((await get(`/api/v1/statuses/${root.id}/quotes`)).body),
            quote: { state: quote.state, id: quote.quoted_status?.id },
        };
    };

    const all = {
        status: 200,
        middle: [leaf.id],
        ancestors: [root.id, middle.id],
        descendants: [middle.id, leaf.id],
        quotes: [quoting.id],
        quote: { state: "accepted", id: middle.id },
    };
    for (const viewerId of [null, "alice", "bob", "carol", "dan"]) {
        assertEquals(await shown(viewerId), all, `${viewerId}`);
    }

    // Replies under carol's are kept, and a quote of carol's still shows what it quotes, as on
    // Mastodon. Dan wrote what carol quoted, so he is still shown the quote.
    await silence(test.ctx, "carol");
    const hidden = { ...all, ancestors: [root.id], descendants: [leaf.id], quotes: [] };
    for (const viewerId of [null, "alice"]) {
        assertEquals(await shown(viewerId), hidden, `${viewerId}`);
    }
    for (const viewerId of ["bob", "carol"]) {
        assertEquals(await shown(viewerId), all, `${viewerId}`);
    }
    assertEquals(await shown("dan"), { ...hidden, quotes: [quoting.id] });

    await unsilence(test.ctx, "carol");
    assertEquals(await shown("alice"), all);
});
