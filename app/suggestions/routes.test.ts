import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { insertFollow } from "../graph/follow_queries.ts";
import type { Scope } from "../kernel/scopes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { suggestionRoutes } from "./routes.ts";

/** Alice, who follows ann, who follows the discoverable bea and cat. Dan is a pick. */
const open = async (suggested_accounts = ["dan"]) => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, suggestionRoutes({ suggested_accounts }), {
        checkResponses: true,
    });
    for (const id of ["alice", "ann", "bea", "cat", "dan"]) await createLocalAccount(test.ctx, id);
    await test.ctx.db.updateTable("accounts").set({ discoverable: true }).execute();
    for (const [follower, followee] of [["alice", "ann"], ["ann", "bea"], ["ann", "cat"]]) {
        await insertFollow(test.ctx, {
            followerId: follower,
            followeeId: followee,
            accepted: true,
            options: {},
        });
    }

    const call = async (
        method: string,
        path: string,
        scopes: Scope[] = ["read", "write"],
        as = "alice",
    ) => {
        const response = await app.request(path, {
            method,
            headers: { authorization: `Bearer ${await tokenFor(test.ctx, as, scopes)}` },
        });

        return { status: response.status, body: await response.json() };
    };

    return { ...test, app, call };
};

Deno.test("suggestions give the picks and friends of friends, each with why", async () => {
    await using test = await open();

    const { status, body } = await test.call("GET", "/api/v2/suggestions");
    assertEquals(status, 200);
    assertEquals(
        body.map((
            one: { source: string; sources: string[]; account: { acct: string } },
        ) => [one.account.acct, one.source, one.sources]),
        [
            ["dan", "staff", ["featured"]],
            ["bea", "past_interactions", ["friends_of_friends"]],
            ["cat", "past_interactions", ["friends_of_friends"]],
        ],
    );
});

Deno.test("suggestions are paged by offset and limit, 40 by default and 80 at most", async () => {
    await using test = await open();
    const acct = async (query: string) =>
        (await test.call("GET", `/api/v2/suggestions${query}`)).body
            .map((one: { account: { acct: string } }) => one.account.acct);

    assertEquals(await acct("?limit=1&offset=1"), ["bea"]);
    assertEquals(await acct("?limit=0"), ["dan"]);
    assertEquals(await acct("?limit=500&offset=2"), ["cat"]);
});

Deno.test("suggestions give 40 by default and 80 at most, as many as the sources have", async () => {
    const picks = Array.from({ length: 45 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    await using test = await open(picks);
    for (let i = 0; i < 45; i++) {
        for (const id of [`p${String(i).padStart(2, "0")}`, `n${String(i).padStart(2, "0")}`]) {
            await createLocalAccount(test.ctx, id);
            await test.ctx.db.updateTable("accounts").set({ discoverable: true })
                .where("id", "=", id).execute();
        }
        await insertFollow(test.ctx, {
            followerId: "ann",
            followeeId: `n${String(i).padStart(2, "0")}`,
            accepted: true,
            options: {},
        });
    }

    const count = async (query: string) =>
        (await test.call("GET", `/api/v2/suggestions${query}`)).body.length;
    assertEquals(await count(""), 40);
    assertEquals(await count("?limit=500"), 80);
    assertEquals(await count("?limit=500&offset=78"), 2);
});

Deno.test("suggestions need a user with the read scope", async () => {
    await using test = await open();

    assertEquals((await test.app.request("/api/v2/suggestions")).status, 401);
    assertEquals((await test.call("GET", "/api/v2/suggestions", ["write"])).status, 403);
    assertEquals((await test.call("DELETE", "/api/v1/suggestions/bea", ["read"])).status, 403);
});

Deno.test("a dismissed suggestion is gone, and dismissing an unknown account answers the same", async () => {
    await using test = await open();

    assertEquals(await test.call("DELETE", "/api/v1/suggestions/bea"), { status: 200, body: {} });
    assertEquals(await test.call("DELETE", "/api/v1/suggestions/nobody"), {
        status: 200,
        body: {},
    });
    assertEquals(
        (await test.call("GET", "/api/v2/suggestions")).body
            .map((one: { account: { acct: string } }) => one.account.acct),
        ["dan", "cat"],
    );
});
