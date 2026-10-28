import { assertEquals } from "@std/assert";
import { createInstance } from "../instances/testing.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { follow } from "../graph/follows.ts";
import { like } from "../interactions/likes.ts";
import { createNote } from "../notes/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { indexUnindexedAccounts } from "./accounts.ts";
import { indexUnindexed } from "./notes.ts";
import { searchRoutes } from "./routes.ts";

/** Alice, who follows annie, and anna, each indexed as if from before Verso searched accounts. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, searchRoutes, { checkResponses: true });
    await createInstance(test.ctx, "b.example");
    for (const id of ["alice", "anna", "annie"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "alice", "annie");
    await indexUnindexedAccounts(test.ctx);

    const request = async (path: string, token?: string | null) => {
        const headers: Record<string, string> = {};
        if (token !== null) {
            headers.authorization = `Bearer ${token ?? await tokenFor(test.ctx, "alice")}`;
        }

        const response = await app.request(path, { headers });
        return { status: response.status, body: await response.json() };
    };

    /** The usernames of the accounts alice finds at `path`. */
    const find = async (path: string) => {
        const { status, body } = await request(path);
        assertEquals(status, 200);
        return body.map((account: { username: string }) => account.username);
    };

    return { ...test, request, find };
};

Deno.test("accounts are searched as Mastodon's options say", async () => {
    await using test = await open();

    assertEquals(await test.find("/api/v1/accounts/search?q=ann"), ["annie", "anna"]);
    assertEquals(await test.find("/api/v1/accounts/search?q=ann&limit=1&offset=1"), ["anna"]);
    // At least one.
    assertEquals(await test.find("/api/v1/accounts/search?q=ann&limit=0"), ["annie"]);
    assertEquals(await test.find("/api/v1/accounts/search?q=ann&following=true"), ["annie"]);

    // At most 80, and 40 unless asked.
    for (let i = 0; i < 81; i++) await createLocalAccount(test.ctx, `zed${i}`);
    await indexUnindexedAccounts(test.ctx);
    assertEquals((await test.find("/api/v1/accounts/search?q=zed&limit=100")).length, 80);
    assertEquals((await test.find("/api/v1/accounts/search?q=zed")).length, 40);

    assertEquals(await test.find("/api/v1/accounts/search?q=nobody@b.example"), []);
    assertEquals(test.transport.sent, []);
    assertEquals(await test.find("/api/v1/accounts/search?q=nobody@b.example&resolve=1"), []);
    assertEquals(test.transport.sent.length, 1);
});

Deno.test("only signed-in users search accounts, for a query", async () => {
    await using test = await open();

    assertEquals((await test.request("/api/v1/accounts/search?q=ann", null)).status, 401);
    assertEquals((await test.request("/api/v1/accounts/search")).status, 422);
    assertEquals((await test.request("/api/v1/accounts/search?q=ann&offset=-1")).status, 422);
});

/** What `/api/v2/search` finds at `path`: usernames, status ids and hashtag names. */
const searched = (body: {
    accounts: { username: string }[];
    statuses: { id: string }[];
    hashtags: { name: string }[];
}) => ({
    accounts: body.accounts.map((account) => account.username),
    statuses: body.statuses.map((status) => status.id),
    hashtags: body.hashtags.map((tag) => tag.name),
});

/** As {@link open}, with alice's status about an annual meeting, tagged #annual. */
const openAnnual = async () => {
    const test = await open();
    const note = await createNote(
        test.ctx,
        "alice",
        {
            content: "Annual meeting",
            content_html: "<p>Annual meeting</p>",
        },
        [],
        ["annual"],
    );
    await indexUnindexed(test.ctx);

    /** What alice, or `token`'s user, finds at `path`. */
    const search = async (path: string, token?: string | null) => {
        const { status, body } = await test.request(path, token);
        assertEquals(status, 200);
        return searched(body);
    };

    return { ...test, id: note.id, search };
};

Deno.test("accounts, statuses and hashtags are searched together, or one of them a page at a time", async () => {
    await using test = await openAnnual();
    const all = { accounts: ["annie", "anna"], statuses: [test.id], hashtags: ["annual"] };
    const none = { accounts: [], statuses: [], hashtags: [] };

    assertEquals(await test.search("/api/v2/search?q=ann"), all);
    const { body } = await test.request("/api/v2/search?q=annual&type=hashtags");
    assertEquals(body.hashtags[0].history.length, 7);

    // An offset needs a type.
    assertEquals(await test.search("/api/v2/search?q=ann&offset=1"), all);
    assertEquals(await test.search("/api/v2/search?q=ann&type=accounts&offset=1"), {
        ...none,
        accounts: ["anna"],
    });
    assertEquals(await test.search("/api/v2/search?q=ann&type=statuses"), {
        ...none,
        statuses: [test.id],
    });
    assertEquals(await test.search("/api/v2/search?q=ann&type=statuses&offset=1"), none);
    assertEquals(await test.search("/api/v2/search?q=ann&type=hashtags&offset=1"), none);
    assertEquals((await test.request("/api/v2/search?q=ann&type=nothing")).status, 422);

    assertEquals(await test.search("/api/v2/search?q=ann&following=true"), {
        ...all,
        accounts: ["annie"],
    });
    assertEquals(await test.search("/api/v2/search?q=nobody@b.example"), none);
    assertEquals(test.transport.sent, []);
    assertEquals(await test.search("/api/v2/search?q=nobody@b.example&resolve=true"), none);
    assertEquals(test.transport.sent.length, 1);

    // As alice sees it.
    await like(test.ctx, "alice", test.id);
    const liked = await test.request("/api/v2/search?q=annual&type=statuses");
    assertEquals(liked.body.statuses[0].favourited, true);

    for (const options of ["account_id=anna", `max_id=${test.id}`, `min_id=${test.id}`]) {
        assertEquals(await test.search(`/api/v2/search?q=ann&${options}`), {
            ...all,
            statuses: [],
        }, options);
    }
});

Deno.test("a search returns 20 of each unless asked, and at most 40", async () => {
    await using test = await openAnnual();
    for (let i = 0; i < 41; i++) await createLocalAccount(test.ctx, `zed${i}`);
    await indexUnindexedAccounts(test.ctx);

    assertEquals((await test.search("/api/v2/search?q=zed")).accounts.length, 20);
    assertEquals((await test.search("/api/v2/search?q=zed&limit=50")).accounts.length, 40);
    assertEquals(await test.search("/api/v2/search?q=ann&limit=0"), {
        accounts: ["annie"],
        statuses: [test.id],
        hashtags: ["annual"],
    });
});

Deno.test("without signing in, statuses aren't searched, and pages and lookups are refused", async () => {
    await using test = await openAnnual();

    assertEquals(await test.search("/api/v2/search?q=annie", null), {
        accounts: ["annie"],
        statuses: [],
        hashtags: [],
    });
    assertEquals(await test.search("/api/v2/search?q=annual&resolve=false", null), {
        accounts: [],
        statuses: [],
        hashtags: ["annual"],
    });

    for (
        const [options, error] of [
            ["offset=0", "Search queries pagination is not supported without authentication"],
            [
                "resolve=true",
                "Search queries that resolve remote resources are not supported without " +
                "authentication",
            ],
        ]
    ) {
        const { status, body } = await test.request(`/api/v2/search?q=annual&${options}`, null);
        assertEquals([status, body.error], [401, error], options);
    }
});

Deno.test("searching needs permission to", async () => {
    await using test = await openAnnual();
    const app = createTestApp(test.ctx, searchRoutes, {
        checkResponses: true,
        permissions: { anonymous: [], default: ["read:account", "read:note"] },
    });
    const token = await tokenFor(test.ctx, "alice");

    for (const path of ["/api/v1/accounts/search?q=ann", "/api/v2/search?q=ann"]) {
        const response = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
        assertEquals(response.status, 403, path);
        await response.body?.cancel();
    }
});
