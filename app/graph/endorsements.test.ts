import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { endorsementRoutes } from "./endorsement_routes.ts";
import { endorsedAmong } from "./endorsement_queries.ts";
import { endorse } from "./endorsements.ts";
import { follow, rejectFollow, unfollow } from "./follows.ts";

/** alice, who follows bob, carol and the remote dave, and bob, who follows no one. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, endorsementRoutes, { checkResponses: true });
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "dave", "b.example");
    for (const id of ["bob", "carol"]) await follow(test.ctx, "alice", id);
    await follow(test.ctx, "alice", "dave");
    await test.ctx.db.updateTable("follows").set({ accepted: true }).execute();

    /** Sends a request as `as`. */
    const request = async (method: string, path: string, as = "alice") => {
        const headers = { authorization: `Bearer ${await tokenFor(test.ctx, as)}` };
        const response = await app.request(path, { method, headers });

        return {
            status: response.status,
            link: response.headers.get("link"),
            body: await response.json(),
        };
    };

    return { ...test, request };
};

Deno.test("a user features accounts they follow, and stops featuring them", async () => {
    await using test = await open();

    const pinned = await test.request("POST", "/api/v1/accounts/bob/pin");
    assertEquals([pinned.status, pinned.body.id, pinned.body.endorsed], [200, "bob", true]);
    assertEquals((await test.request("POST", "/api/v1/accounts/bob/pin")).body.endorsed, true);
    assertEquals((await test.request("POST", "/api/v1/accounts/dave/pin")).body.endorsed, true);

    const unpinned = await test.request("POST", "/api/v1/accounts/bob/unpin");
    assertEquals([unpinned.status, unpinned.body.endorsed], [200, false]);
    assertEquals((await test.request("POST", "/api/v1/accounts/bob/unpin")).status, 200);
});

Deno.test("only followed accounts can be featured", async () => {
    await using test = await open();

    assertEquals((await test.request("POST", "/api/v1/accounts/alice/pin", "bob")).status, 422);
    assertEquals((await test.request("POST", "/api/v1/accounts/alice/pin")).status, 422);
    assertEquals((await test.request("POST", "/api/v1/accounts/missing/pin")).status, 404);
    assertEquals((await test.request("POST", "/api/v1/accounts/missing/unpin")).status, 404);
});

Deno.test("ending a follow stops featuring the account", async () => {
    await using test = await open();
    for (const id of ["bob", "carol", "dave"]) await endorse(test.ctx, "alice", id);

    await unfollow(test.ctx, "alice", "bob");
    // As when dave's instance says the follow was rejected.
    await rejectFollow(test.ctx, "alice", "dave");

    assertEquals(
        await endorsedAmong(test.ctx, "alice", ["bob", "carol", "dave"]),
        new Set(["carol"]),
    );
});

Deno.test("the featured accounts are listed, the latest featured first, in pages", async () => {
    await using test = await open();
    for (const id of ["dave", "bob", "carol"]) await endorse(test.ctx, "alice", id);
    const ids = (body: { id: string }[]) => body.map((account) => account.id);

    assertEquals(ids((await test.request("GET", "/api/v1/endorsements")).body), [
        "carol",
        "bob",
        "dave",
    ]);
    assertEquals((await test.request("GET", "/api/v1/endorsements", "bob")).body, []);

    const first = await test.request("GET", "/api/v1/endorsements?limit=2");
    assertEquals(ids(first.body), ["carol", "bob"]);
    const next = new URL(first.link?.match(/<([^>]+)>; rel="next"/)?.[1] ?? "");
    assertEquals(ids((await test.request("GET", next.pathname + next.search)).body), ["dave"]);
});
