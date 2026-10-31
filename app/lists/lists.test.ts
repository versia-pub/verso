import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { acceptFollow, follow, rejectFollow, unfollow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { listAccountPage } from "./list_queries.ts";
import { addListAccounts, createList, listLimit } from "./lists.ts";
import { listRoutes } from "./routes.ts";

/**
 * alice, who follows bob and carol and has requested to follow the remote dave, bob, who follows no
 * one, and erin, whom no one follows.
 */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, listRoutes, { checkResponses: true });
    for (const id of ["alice", "bob", "carol", "erin"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "dave", "b.example");
    for (const id of ["bob", "carol", "dave"]) await follow(test.ctx, "alice", id);

    /** Sends a request as `as`, with `body` as JSON. */
    const request = async (method: string, path: string, body?: unknown, as = "alice") => {
        const headers: HeadersInit = {
            authorization: `Bearer ${await tokenFor(test.ctx, as)}`,
            ...body === undefined ? {} : { "content-type": "application/json" },
        };
        const response = await app.request(path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        return {
            status: response.status,
            link: response.headers.get("link"),
            body: await response.json(),
        };
    };

    /** Makes a list for `as`, and returns its id. */
    const list = async (title: string, as = "alice") => {
        const made = await createList(test.ctx, as, {
            title,
            replies_policy: "list",
            exclusive: false,
        });
        if (made === "full") throw new Error("Too many lists");

        return made.id;
    };

    /** The ids of the accounts in the list `id`. */
    const members = async (id: string) =>
        (await listAccountPage(test.ctx, id, null)).map((row) => row.account_id);

    return { ...test, request, list, members };
};

const ids = (body: { id: string }[]) => body.map((item) => item.id);

Deno.test("a user makes lists, changes them, and deletes them", async () => {
    await using test = await open();

    const made = await test.request("POST", "/api/v1/lists", { title: "Friends" });
    assertEquals(made.status, 200);
    assertEquals([made.body.title, made.body.replies_policy, made.body.exclusive], [
        "Friends",
        "list",
        false,
    ]);
    const other = await test.request("POST", "/api/v1/lists", {
        title: "Work",
        replies_policy: "none",
        exclusive: true,
    });
    assertEquals([other.body.replies_policy, other.body.exclusive], ["none", true]);

    const changed = await test.request("PUT", `/api/v1/lists/${made.body.id}`, {
        replies_policy: "followed",
    });
    assertEquals([changed.body.title, changed.body.replies_policy], ["Friends", "followed"]);
    assertEquals((await test.request("GET", `/api/v1/lists/${made.body.id}`)).body, changed.body);
    assertEquals(ids((await test.request("GET", "/api/v1/lists")).body), [
        made.body.id,
        other.body.id,
    ]);

    assertEquals((await test.request("DELETE", `/api/v1/lists/${other.body.id}`)).body, {});
    assertEquals((await test.request("GET", `/api/v1/lists/${other.body.id}`)).status, 404);
    assertEquals(ids((await test.request("GET", "/api/v1/lists")).body), [made.body.id]);
});

Deno.test("a list needs a title, and no one else sees or changes it", async () => {
    await using test = await open();
    const id = await test.list("Friends");

    assertEquals((await test.request("POST", "/api/v1/lists", { title: " " })).status, 422);
    assertEquals((await test.request("POST", "/api/v1/lists", {})).status, 422);
    const policy = { title: "Friends", replies_policy: "some" };
    assertEquals((await test.request("POST", "/api/v1/lists", policy)).status, 422);
    assertEquals((await test.request("PUT", `/api/v1/lists/${id}`, { title: "" })).status, 422);

    assertEquals((await test.request("GET", "/api/v1/lists", undefined, "bob")).body, []);
    for (const method of ["GET", "PUT", "DELETE"]) {
        const body = method === "PUT" ? {} : undefined;
        assertEquals((await test.request(method, `/api/v1/lists/${id}`, body, "bob")).status, 404);
    }
    const added = await test.request("POST", `/api/v1/lists/${id}/accounts`, {
        account_ids: ["alice"],
    }, "bob");
    assertEquals(added.status, 404);
    assertEquals((await test.request("GET", `/api/v1/lists/${id}`)).body.title, "Friends");
});

Deno.test("a user may have at most as many lists as on Mastodon", async () => {
    await using test = await open();
    for (let i = 0; i < listLimit; i++) await test.list(`List ${i}`);

    const full = await test.request("POST", "/api/v1/lists", { title: "One more" });
    assertEquals(full.status, 422);
    assertEquals((await test.request("GET", "/api/v1/lists")).body.length, listLimit);

    const bobs = await test.request("POST", "/api/v1/lists", { title: "Bob's" }, "bob");
    assertEquals(bobs.status, 200);
});

Deno.test("a list holds the accounts its owner follows or asked to, and the owner", async () => {
    await using test = await open();
    const id = await test.list("Friends");
    const add = (accountIds: string[]) =>
        test.request("POST", `/api/v1/lists/${id}/accounts`, { account_ids: accountIds });

    assertEquals((await add(["bob", "dave", "alice"])).body, {});
    assertEquals(new Set(await test.members(id)), new Set(["bob", "dave", "alice"]));

    // Each request adds all its accounts or none of them.
    assertEquals((await add(["carol", "erin"])).status, 422);
    assertEquals((await add(["carol", "bob"])).status, 422);
    assertEquals((await add(["carol", "missing"])).status, 404);
    assertEquals((await test.members(id)).includes("carol"), false);

    const removed = await test.request("DELETE", `/api/v1/lists/${id}/accounts?account_ids[]=bob`, {
        account_ids: ["dave", "erin"],
    });
    assertEquals(removed.body, {});
    assertEquals(await test.members(id), ["alice"]);
});

Deno.test("ending a follow or a request removes the account from the owner's lists", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "frank");
    await follow(test.ctx, "alice", "frank");
    const id = await test.list("Friends");
    const other = await test.list("Others");
    assertEquals(await addListAccounts(test.ctx, "alice", id, ["bob", "carol", "dave"]), "added");
    assertEquals(await addListAccounts(test.ctx, "alice", other, ["carol", "frank"]), "added");

    await unfollow(test.ctx, "alice", "bob");
    // As when frank removes alice from his followers, and dave's instance accepts her request.
    await rejectFollow(test.ctx, "alice", "frank");
    await acceptFollow(test.ctx, "alice", "dave");

    assertEquals(new Set(await test.members(id)), new Set(["carol", "dave"]));
    assertEquals(await test.members(other), ["carol"]);
});

Deno.test("a list's accounts are listed, the latest added first, in pages or all at once", async () => {
    await using test = await open();
    const id = await test.list("Friends");
    for (const account of ["dave", "bob", "carol"]) {
        await addListAccounts(test.ctx, "alice", id, [account]);
    }
    const path = `/api/v1/lists/${id}/accounts`;

    const first = await test.request("GET", `${path}?limit=2`);
    assertEquals(ids(first.body), ["carol", "bob"]);
    const next = new URL(first.link?.match(/<([^>]+)>; rel="next"/)?.[1] ?? "");
    assertEquals(ids((await test.request("GET", next.pathname + next.search)).body), ["dave"]);

    const all = await test.request("GET", `${path}?limit=0`);
    assertEquals([ids(all.body), all.link], [["carol", "bob", "dave"], null]);
    assertEquals((await test.request("GET", path, undefined, "bob")).status, 404);
});

Deno.test("an account's lists are those of the viewer it is in", async () => {
    await using test = await open();
    await follow(test.ctx, "bob", "carol");
    const friends = await test.list("Friends");
    await test.list("Work");
    const bobs = await test.list("Bob's", "bob");
    await addListAccounts(test.ctx, "alice", friends, ["carol"]);
    await addListAccounts(test.ctx, "bob", bobs, ["carol"]);

    const lists = await test.request("GET", "/api/v1/accounts/carol/lists");
    assertEquals(ids(lists.body), [friends]);
    assertEquals((await test.request("GET", "/api/v1/accounts/bob/lists")).body, []);
    assertEquals((await test.request("GET", "/api/v1/accounts/missing/lists")).status, 404);
});
