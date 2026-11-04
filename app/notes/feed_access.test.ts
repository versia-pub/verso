import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { Permissions, TimelinesAccess } from "../kernel/config_sections.ts";
import { createTestApp } from "../testing/app.ts";
import type { RouteViewer } from "../http/route.ts";
import type { Permission } from "../kernel/permissions.ts";
import { seenOf } from "./feed_access.ts";
import { createTestContext } from "../testing/context.ts";
import { createNote } from "./testing.ts";
import { timelineRoutes } from "./timeline_routes.ts";

/** Local and remote statuses of the hashtag `verso`, with a user, and an app for `access`. */
const open = async (access: Parameters<typeof TimelinesAccess.parse>[0]) => {
    const test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    test.clock.advance(1);
    const local = await createNote(test.ctx, "alice", {}, [], ["verso"]);
    test.clock.advance(1);
    const remote = await createNote(
        test.ctx,
        "carol",
        { instance_id: "b.example", remote_id: "c1" },
        [],
        ["verso"],
    );

    const permissions = Permissions.parse({});
    const routes = timelineRoutes(TimelinesAccess.parse(access));
    const app = createTestApp(test.ctx, routes);
    const allowed = createTestApp(test.ctx, routes, {
        permissions: { ...permissions, default: [...permissions.default, "feeds"] },
    });

    /** The ids a timeline gives, or the status if it refuses. */
    const get = async (path: string, as: string | null = null, on = app) => {
        const headers: HeadersInit = as === null
            ? {}
            : { authorization: `Bearer ${await tokenFor(test.ctx, as)}` };
        const response = await on.request(path, { headers });
        const body = await response.json();

        return response.status === 200
            ? body.map((status: { id: string }) => status.id)
            : { status: response.status, error: body.error };
    };

    return { ...test, local, remote, get, app, allowed };
};

const noUser = { status: 422, error: "This method requires an authenticated user" };

Deno.test("a public timeline for logged-in users is refused to anyone else", async () => {
    await using test = await open({
        live_feeds: { local: "authenticated", remote: "authenticated" },
    });
    const both = [test.remote.id, test.local.id];

    assertEquals(await test.get("/api/v1/timelines/public"), noUser);
    assertEquals(await test.get("/api/v1/timelines/public?local=true"), noUser);
    assertEquals(await test.get("/api/v1/timelines/public?remote=true"), noUser);
    assertEquals(await test.get("/api/v1/timelines/public", "alice"), both);
    // The hashtag timeline is a different setting.
    assertEquals(await test.get("/api/v1/timelines/tag/verso"), both);
});

Deno.test("only the origin a request asks about decides whether it needs a user", async () => {
    await using test = await open({ live_feeds: { local: "public", remote: "authenticated" } });

    assertEquals(await test.get("/api/v1/timelines/public?local=true"), [test.local.id]);
    assertEquals(await test.get("/api/v1/timelines/public?remote=true"), noUser);
    // `local` wins, as it does for what is returned.
    assertEquals(await test.get("/api/v1/timelines/public?local=true&remote=true"), [
        test.local.id,
    ]);
    // Both are asked about when neither is named.
    assertEquals(await test.get("/api/v1/timelines/public"), noUser);
});

Deno.test("a disabled feed is empty to users without the feeds permission", async () => {
    await using test = await open({ live_feeds: { local: "public", remote: "disabled" } });

    assertEquals(await test.get("/api/v1/timelines/public"), noUser);
    // What they may see is returned, and nothing for what they may not.
    assertEquals(await test.get("/api/v1/timelines/public", "alice"), [test.local.id]);
    assertEquals(await test.get("/api/v1/timelines/public?local=true", "alice"), [test.local.id]);
    assertEquals(await test.get("/api/v1/timelines/public?remote=true", "alice"), []);
    assertEquals(
        await test.get("/api/v1/timelines/public", "alice", test.allowed),
        [test.remote.id, test.local.id],
    );
    assertEquals(await test.get("/api/v1/timelines/public?remote=true", "alice", test.allowed), [
        test.remote.id,
    ]);
});

Deno.test("a feed disabled on both sides is empty even for local statuses", async () => {
    await using test = await open({ live_feeds: { local: "disabled", remote: "disabled" } });

    assertEquals(await test.get("/api/v1/timelines/public", "alice"), []);
    assertEquals(await test.get("/api/v1/timelines/public?local=true", "alice"), []);
    assertEquals(
        await test.get("/api/v1/timelines/public", "alice", test.allowed),
        [test.remote.id, test.local.id],
    );
});

Deno.test("hashtag timelines have their own settings", async () => {
    await using test = await open({
        live_feeds: { local: "authenticated", remote: "authenticated" },
        topic_feeds: { local: "public", remote: "disabled" },
    });

    assertEquals(await test.get("/api/v1/timelines/tag/verso"), noUser);
    assertEquals(await test.get("/api/v1/timelines/tag/verso?local=true"), [test.local.id]);
    assertEquals(await test.get("/api/v1/timelines/tag/verso", "alice"), [test.local.id]);
    assertEquals(
        await test.get("/api/v1/timelines/tag/verso", "alice", test.allowed),
        [test.remote.id, test.local.id],
    );
    assertEquals(await test.get("/api/v1/timelines/public"), noUser);
});

Deno.test("an app acting for itself isn't a user", async () => {
    await using test = await open({ live_feeds: { local: "authenticated" } });
    const token = await tokenFor(test.ctx, null);
    const response = await test.app.request("/api/v1/timelines/public", {
        headers: { authorization: `Bearer ${token}` },
    });

    assertEquals(response.status, 422);
});

Deno.test("only a user is logged in, and only a role with the feeds permission sees disabled feeds", async () => {
    const viewer = (accountId: string | null, permissions: Permission[]): RouteViewer => ({
        tokenId: "token",
        appId: "app",
        accountId,
        scopes: ["read"],
        forgetPermissions: () => {},
        permissions: () => Promise.resolve(new Set(permissions)),
    });
    const feeds = (local: "public" | "authenticated" | "disabled", remote = local) =>
        TimelinesAccess.parse({ live_feeds: { local, remote } }).live_feeds;
    const nobody = { local: false, remote: false };
    const everything = { local: true, remote: true };

    assertEquals(await seenOf(feeds("public"), undefined), everything);
    assertEquals(await seenOf(feeds("authenticated"), undefined), nobody);
    assertEquals(await seenOf(feeds("authenticated"), viewer(null, ["feeds"])), nobody);
    assertEquals(await seenOf(feeds("authenticated"), viewer("alice", [])), everything);
    assertEquals(await seenOf(feeds("disabled"), undefined), nobody);
    assertEquals(await seenOf(feeds("disabled"), viewer("alice", ["read:note"])), nobody);
    assertEquals(await seenOf(feeds("disabled"), viewer("alice", ["feeds"])), everything);
    assertEquals(
        await seenOf(feeds("disabled", "public"), viewer("alice", [])),
        { local: false, remote: true },
    );
});
