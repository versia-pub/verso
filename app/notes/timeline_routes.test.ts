import { assertEquals, assertStringIncludes } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { block } from "../graph/blocks.ts";
import { blockDomainFor } from "../graph/domain_blocks.ts";
import { follow } from "../graph/follows.ts";
import { mute } from "../graph/mutes.ts";
import { routes } from "../http/routes.ts";
import { share } from "../interactions/shares.ts";
import { createInstance, defaultSettings } from "../instances/testing.ts";
import { addListAccounts, createList } from "../lists/lists.ts";
import type { Scope } from "../kernel/scopes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { createNote } from "./testing.ts";
import { timelineRoutes } from "./timeline_routes.ts";

const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "alice", "bob");
    const app = createTestApp(test.ctx, timelineRoutes, { checkResponses: true });

    const home = async (query = "", as: string | null = "alice", scopes?: Scope[], on = app) => {
        const headers: HeadersInit = as === null
            ? {}
            : { authorization: `Bearer ${await tokenFor(test.ctx, as, scopes)}` };
        const response = await on.request(`/api/v1/timelines/home${query}`, { headers });

        return {
            status: response.status,
            link: response.headers.get("link"),
            body: await response.json(),
        };
    };

    /** The public timeline, as anyone sees it, or as `as` sees it. */
    const everyone = async (query = "", as: string | null = null, on = app) => {
        const headers: HeadersInit = as === null
            ? {}
            : { authorization: `Bearer ${await tokenFor(test.ctx, as)}` };
        const response = await on.request(`/api/v1/timelines/public${query}`, { headers });

        return {
            status: response.status,
            link: response.headers.get("link"),
            body: await response.json(),
        };
    };

    /** The ids on `hashtag`'s timeline, as anyone sees it, or as `as` sees it. */
    const tagged = async (hashtag: string, query = "", as: string | null = null) => {
        const headers: HeadersInit = as === null
            ? {}
            : { authorization: `Bearer ${await tokenFor(test.ctx, as)}` };
        const response = await app.request(`/api/v1/timelines/tag/${hashtag}${query}`, { headers });
        assertEquals(response.status, 200);

        const body: { id: string; favourited?: boolean }[] = await response.json();
        return { ids: body.map((status) => status.id), body, link: response.headers.get("link") };
    };

    return { ...test, home, everyone, tagged };
};

Deno.test("home gives the viewer's statuses and those they follow, a page at a time", async () => {
    await using test = await open();
    const ids = [];
    for (const accountId of ["alice", "bob", "bob"]) {
        test.clock.advance(1);
        ids.push((await createNote(test.ctx, accountId)).id);
    }

    const page = await test.home("?limit=2");
    assertEquals(page.status, 200);
    assertEquals(page.body.map((status: { id: string }) => status.id), [ids[2], ids[1]]);
    assertStringIncludes(page.link ?? "", `max_id=${ids[1]}>; rel="next"`);
    assertEquals(page.body[0].favourited, false);

    const next = await test.home(`?max_id=${ids[1]}`);
    assertEquals(next.body.map((status: { id: string }) => status.id), [ids[0]]);
    assertEquals((await test.home("", "bob")).body.length, 2);

    for (let i = 0; i < 20; i++) await createNote(test.ctx, "bob");
    assertEquals((await test.home()).body.length, 20);
});

Deno.test("timelines leave out the statuses of the accounts the viewer blocks", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "bob");
    await block(test.ctx, "alice", "bob");
    const ids = (page: { body: { id: string }[] }) => page.body.map((status) => status.id);

    assertEquals(ids(await test.home()), []);
    assertEquals(ids(await test.everyone("", "alice")), []);
    assertEquals(ids(await test.everyone()), [note.id]);
});

Deno.test("timelines leave out the statuses of the accounts on the domains the viewer blocks", async () => {
    await using test = await open();
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    const note = await createNote(test.ctx, "carol", { instance_id: "b.example", remote_id: "c1" });
    await share(test.ctx, "bob", note.id, "public");
    await blockDomainFor(test.ctx, "alice", "b.example");
    const ids = (page: { body: { id: string }[] }) => page.body.map((status) => status.id);

    assertEquals(ids(await test.home()), []);
    assertEquals(ids(await test.everyone("", "alice")), []);
    assertEquals(ids(await test.everyone()), [note.id]);
    assertEquals((await test.home("", "bob")).body.length, 1);
});

Deno.test("timelines leave out the statuses of the accounts the viewer mutes", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "bob");
    await mute(test.ctx, "alice", "bob", { notifications: true, duration: 0 });
    const ids = (page: { body: { id: string }[] }) => page.body.map((status) => status.id);

    assertEquals(ids(await test.home()), []);
    assertEquals(ids(await test.everyone("", "alice")), []);
    assertEquals(ids(await test.everyone()), [note.id]);
});

Deno.test("home is only for a logged-in user, with a token and role that may read statuses", async () => {
    await using test = await open();
    const limited = createTestApp(test.ctx, timelineRoutes, {
        permissions: { anonymous: [], default: ["read:account"] },
    });

    assertEquals((await test.home("", null)).status, 401);
    assertEquals((await test.home("", "alice", ["read:accounts"])).status, 403);
    assertEquals((await test.home("", "alice", ["read:statuses"])).status, 200);
    assertEquals((await test.home("", "alice", undefined, limited)).status, 403);
});

Deno.test("home is served among every route", async () => {
    await using test = await open();
    const app = createTestApp(test.ctx, routes(defaultSettings()));
    const response = await app.request("/api/v1/timelines/home", {
        headers: { authorization: `Bearer ${await tokenFor(test.ctx, "alice")}` },
    });

    assertEquals([response.status, await response.json()], [200, []]);
});

Deno.test("the public timeline is for anyone, from here, elsewhere or both", async () => {
    await using test = await open();
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    test.clock.advance(1);
    const local = await createNote(test.ctx, "alice");
    test.clock.advance(1);
    const remote = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "c1",
    });
    const ids = async (query: string, as: string | null = null) =>
        (await test.everyone(query, as)).body.map((status: { id: string }) => status.id);

    assertEquals(await ids(""), [remote.id, local.id]);
    assertEquals(await ids("?local=true"), [local.id]);
    assertEquals(await ids("?remote=1"), [remote.id]);
    assertEquals(await ids("?local=true&remote=true"), [local.id]);
    assertEquals(await ids("?only_media=true"), []);

    const page = await test.everyone("?limit=1");
    assertEquals(page.body.map((status: { id: string }) => status.id), [remote.id]);
    assertStringIncludes(page.link ?? "", `max_id=${remote.id}>; rel="next"`);
    assertEquals(page.body[0].favourited, undefined);
    assertEquals((await test.everyone("", "alice")).body[0].favourited, false);

    for (let i = 0; i < 20; i++) await createNote(test.ctx, "bob");
    assertEquals((await test.everyone()).body.length, 20);
});

Deno.test("the public timeline is only for tokens and roles that may read statuses", async () => {
    await using test = await open();
    const limited = createTestApp(test.ctx, timelineRoutes, {
        permissions: { anonymous: ["read:account"], default: ["read:account"] },
    });

    assertEquals((await test.everyone("", null, limited)).status, 403);
    assertEquals((await test.everyone("", "alice", limited)).status, 403);
    const response = await createTestApp(test.ctx, timelineRoutes).request(
        "/api/v1/timelines/public",
        { headers: { authorization: `Bearer ${await tokenFor(test.ctx, "alice", ["write"])}` } },
    );
    assertEquals(response.status, 403);
});

Deno.test("a hashtag's timeline has the public statuses using it, replies too, for anyone", async () => {
    await using test = await open();
    const post = (
        accountId: string,
        tags: string[],
        note: Parameters<typeof createNote>[2] = {},
    ) => {
        test.clock.advance(1);
        return createNote(test.ctx, accountId, note, [], tags);
    };
    const first = await post("alice", ["verso"]);
    const reply = await post("bob", ["verso", "nix"], {
        in_reply_to_id: first.id,
        in_reply_to_account_id: "alice",
    });
    await post("alice", ["verso"], { visibility: "unlisted" });
    await post("alice", ["verso"], { visibility: "private" });
    const other = await post("alice", ["other"]);
    const both = [reply.id, first.id];

    assertEquals((await test.tagged("verso")).ids, both);
    assertEquals((await test.tagged("VERSO")).ids, both);
    assertEquals((await test.tagged("nothing")).ids, []);
    assertEquals((await test.tagged("verso", "?any[]=%23Other")).ids, [other.id, ...both]);
    assertEquals((await test.tagged("verso", "?all[]=nix")).ids, [reply.id]);
    assertEquals((await test.tagged("verso", "?all[]=nix&all[]=other")).ids, []);
    assertEquals((await test.tagged("verso", "?none[]=nix")).ids, [first.id]);

    // At most four of each, with the hashtag itself first of `any`.
    assertEquals(
        (await test.tagged("verso", "?any[]=a&any[]=b&any[]=c&any[]=other")).ids,
        both,
    );
    assertEquals(
        (await test.tagged("verso", "?any[]=verso&any[]=a&any[]=b&any[]=other")).ids,
        [other.id, ...both],
    );
    assertEquals(
        (await test.tagged("verso", "?all[]=nix&all[]=nix&all[]=nix&all[]=nix&all[]=a")).ids,
        [reply.id],
    );
    assertEquals(
        (await test.tagged("verso", "?none[]=a&none[]=b&none[]=c&none[]=d&none[]=nix")).ids,
        both,
    );

    const page = await test.tagged("verso", "?limit=1");
    assertEquals(page.ids, [reply.id]);
    assertStringIncludes(page.link ?? "", `max_id=${reply.id}>; rel="next"`);
    assertEquals(page.body[0].favourited, undefined);
    assertEquals((await test.tagged("verso", "", "alice")).body[0].favourited, false);
});

Deno.test("a hashtag's timeline is from here, elsewhere or both, and without what the viewer hides", async () => {
    await using test = await open();
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    test.clock.advance(1);
    const local = await createNote(test.ctx, "bob", {}, [], ["verso"]);
    test.clock.advance(1);
    const remote = await createNote(
        test.ctx,
        "carol",
        {
            instance_id: "b.example",
            remote_id: "c1",
        },
        [],
        ["verso"],
    );

    assertEquals((await test.tagged("verso", "?local=true")).ids, [local.id]);
    assertEquals((await test.tagged("verso", "?remote=true")).ids, [remote.id]);
    assertEquals((await test.tagged("verso", "?only_media=true")).ids, []);

    await block(test.ctx, "alice", "bob");
    assertEquals((await test.tagged("verso", "", "alice")).ids, [remote.id]);
    assertEquals((await test.tagged("verso")).ids, [remote.id, local.id]);
});

Deno.test("a list's timeline is only its owner's, with a token that may read lists", async () => {
    await using test = await open();
    const list = await createList(test.ctx, "alice", {
        title: "Friends",
        replies_policy: "list",
        exclusive: false,
    });
    if (list === "full") throw new Error("Too many lists");
    await addListAccounts(test.ctx, "alice", list.id, ["bob"]);
    const note = await createNote(test.ctx, "bob");
    const app = createTestApp(test.ctx, timelineRoutes, { checkResponses: true });

    const read = async (as: string, scopes?: Scope[]) => {
        const response = await app.request(`/api/v1/timelines/list/${list.id}`, {
            headers: { authorization: `Bearer ${await tokenFor(test.ctx, as, scopes)}` },
        });
        return { status: response.status, body: await response.json() };
    };

    const own = await read("alice");
    assertEquals([own.status, own.body.map((status: { id: string }) => status.id)], [200, [
        note.id,
    ]]);
    assertEquals((await read("bob")).status, 404);
    assertEquals((await read("alice", ["read:statuses"])).status, 403);
});
