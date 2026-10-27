import { assertEquals, assertStringIncludes } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { createLocalEmoji } from "../emojis/testing.ts";
import { block, unblock } from "../graph/blocks.ts";
import { blockDomainFor } from "../graph/domain_blocks.ts";
import { follow, unfollow } from "../graph/follows.ts";
import { mute, unmute } from "../graph/mutes.ts";
import { createInstance } from "../instances/testing.ts";
import { like } from "../interactions/likes.ts";
import { react } from "../interactions/reactions.ts";
import type { Scope } from "../kernel/scopes.ts";
import { postNote } from "../notes/notes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { notificationRoutes } from "./routes.ts";

type Shown = {
    id: string;
    type: string;
    group_key: string;
    account: { id: string };
    status?: { id: string };
    emoji?: string;
    emoji_url?: string | null;
};

const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, notificationRoutes, { checkResponses: true });
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "dave", "b.example");

    const request = async (
        method: string,
        path: string,
        options: { as?: string; scopes?: Scope[] } = {},
    ) => {
        const token = await tokenFor(test.ctx, options.as ?? "alice", options.scopes);
        const response = await app.request(path, {
            method,
            headers: { authorization: `Bearer ${token}` },
        });

        return {
            status: response.status,
            body: await response.json(),
            link: response.headers.get("link"),
        };
    };

    /** alice's notifications at `path`, each as its type, who caused it, and its status. */
    const list = async (path = "/api/v1/notifications") => {
        const { status, body } = await request("GET", path);
        assertEquals(status, 200);

        return (body as Shown[]).map((each) =>
            [each.type, each.account.id, each.status?.id ?? ""].join(" ").trim()
        );
    };

    const post = async (accountId: string, text: string, visibility?: "private") => {
        const note = await postNote(test.ctx, accountId, {
            text,
            format: "text/plain",
            spoilerText: "",
            visibility,
        });
        if (note === undefined) throw new Error("Not posted");
        return note;
    };

    return { ...test, request, list, post };
};

Deno.test("notifications are listed newest first, with who caused them and the status", async () => {
    await using test = await open();
    const mention = await test.post("bob", "Hi @alice");
    const own = await test.post("alice", "Hi");
    await like(test.ctx, "carol", own.id);
    await follow(test.ctx, "dave", "alice");

    assertEquals(await test.list(), [
        "follow dave",
        `favourite carol ${own.id}`,
        `mention bob ${mention.id}`,
    ]);

    const { body } = await test.request("GET", "/api/v1/notifications");
    const [followed, , mentioned] = body as Shown[];
    const hour = Math.floor(test.clock.now().getTime() / 3_600_000);
    assertEquals(followed?.group_key, `follow--${hour}`);
    assertEquals(followed?.status, undefined);
    assertEquals(mentioned?.group_key, `ungrouped-${mentioned?.id}`);
});

Deno.test("reaction notifications have the emoji, and a custom one's picture", async () => {
    await using test = await open();
    await createLocalEmoji(test.ctx, "blob");
    const own = await test.post("alice", "Hi");
    await react(test.ctx, "bob", own.id, "🎉");
    await react(test.ctx, "carol", own.id, ":blob:");

    const { body } = await test.request("GET", "/api/v1/notifications");
    assertEquals((body as Shown[]).map((each) => [each.type, each.emoji, each.emoji_url]), [
        ["reaction", ":blob:", "https://social.example/media/emoji-blob"],
        ["reaction", "🎉", null],
    ]);
});

Deno.test("notifications are filtered by type, leaving out types Verso doesn't have", async () => {
    await using test = await open();
    const mention = await test.post("bob", "Hi @alice");
    await follow(test.ctx, "carol", "alice");
    await follow(test.ctx, "bob", "alice");

    const all = ["follow bob", "follow carol", `mention bob ${mention.id}`];
    assertEquals(await test.list("/api/v1/notifications?types[]=mention"), [all[2]]);
    assertEquals(await test.list("/api/v1/notifications?types=mention&types=follow"), all);
    assertEquals(await test.list("/api/v1/notifications?types[]=poll"), []);
    assertEquals(await test.list("/api/v1/notifications?exclude_types[]=follow"), [all[2]]);
    assertEquals(await test.list("/api/v1/notifications?exclude_types[]=poll"), all);
    assertEquals(await test.list("/api/v1/notifications?account_id=bob"), [all[0], all[2]]);
});

Deno.test("notifications are paged, with links to the pages around", async () => {
    await using test = await open();
    for (const id of ["bob", "carol", "dave"]) await follow(test.ctx, id, "alice");

    const page = await test.request("GET", "/api/v1/notifications?limit=2");
    const ids = (page.body as Shown[]).map((each) => each.id);
    assertEquals(ids.length, 2);
    assertStringIncludes(page.link ?? "", `max_id=${ids[1]}>; rel="next"`);
    assertStringIncludes(page.link ?? "", `min_id=${ids[0]}>; rel="prev"`);

    assertEquals(await test.list(`/api/v1/notifications?max_id=${ids[1]}`), ["follow bob"]);
});

Deno.test("notifications from accounts the user blocks or mutes are hidden, until they aren't", async () => {
    await using test = await open();
    const mention = await test.post("bob", "Hi @alice");
    await follow(test.ctx, "carol", "alice");
    await follow(test.ctx, "dave", "alice");
    const all = ["follow dave", "follow carol", `mention bob ${mention.id}`];

    await block(test.ctx, "alice", "bob");
    await mute(test.ctx, "alice", "carol", { notifications: true, duration: 0 });
    await blockDomainFor(test.ctx, "alice", "b.example");
    assertEquals(await test.list(), []);

    await unblock(test.ctx, "alice", "bob");
    await unmute(test.ctx, "alice", "carol");
    assertEquals(await test.list(), [all[1], all[2]]);

    // A mute that leaves notifications alone hides none.
    await mute(test.ctx, "alice", "carol", { notifications: false, duration: 0 });
    assertEquals(await test.list(), [all[1], all[2]]);
});

Deno.test("notifications about statuses the user may no longer see are hidden", async () => {
    await using test = await open();
    await follow(test.ctx, "alice", "bob", { notify: true });
    const note = await test.post("bob", "Hi", "private");
    assertEquals(await test.list(), [`status bob ${note.id}`]);

    await unfollow(test.ctx, "alice", "bob");
    assertEquals(await test.list(), []);
    assertEquals((await test.request("GET", `/api/v1/notifications?types[]=status`)).body, []);
});

Deno.test("a notification is shown and dismissed only by its user", async () => {
    await using test = await open();
    await follow(test.ctx, "bob", "alice");
    await follow(test.ctx, "carol", "alice");
    const [id] = (await test.request("GET", "/api/v1/notifications")).body.map((each: Shown) =>
        each.id
    );

    const shown = await test.request("GET", `/api/v1/notifications/${id}`);
    assertEquals([shown.status, shown.body.type, shown.body.account.id], [200, "follow", "carol"]);
    assertEquals(
        (await test.request("GET", `/api/v1/notifications/${id}`, { as: "bob" })).status,
        404,
    );
    assertEquals(
        (await test.request("POST", `/api/v1/notifications/${id}/dismiss`, { as: "bob" })).status,
        404,
    );

    const dismissed = await test.request("POST", `/api/v1/notifications/${id}/dismiss`);
    assertEquals([dismissed.status, dismissed.body], [200, {}]);
    assertEquals((await test.request("GET", `/api/v1/notifications/${id}`)).status, 404);
    assertEquals((await test.request("POST", `/api/v1/notifications/${id}/dismiss`)).status, 404);
});

Deno.test("clearing dismisses all the user's notifications, and no one else's", async () => {
    await using test = await open();
    await follow(test.ctx, "bob", "alice");
    await follow(test.ctx, "carol", "alice");
    await follow(test.ctx, "alice", "bob");

    const cleared = await test.request("POST", "/api/v1/notifications/clear");
    assertEquals([cleared.status, cleared.body], [200, {}]);
    assertEquals(await test.list(), []);
    assertEquals(
        (await test.request("GET", "/api/v1/notifications", { as: "bob" })).body.length,
        1,
    );
});

Deno.test("reading notifications takes read:notifications, and dismissing them write", async () => {
    await using test = await open();
    const reading = { scopes: ["read:statuses" as const] };
    const writing = { scopes: ["read:notifications" as const] };

    assertEquals((await test.request("GET", "/api/v1/notifications", reading)).status, 403);
    assertEquals((await test.request("GET", "/api/v1/notifications", writing)).status, 200);
    assertEquals(
        (await test.request("POST", "/api/v1/notifications/clear", writing)).status,
        403,
    );
});
