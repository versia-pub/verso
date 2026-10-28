import { assertEquals } from "@std/assert";
import { createInstance } from "../instances/testing.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { follow } from "../graph/follows.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { indexUnindexedAccounts } from "./accounts.ts";
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
