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

type Group = {
    group_key: string;
    notifications_count: number;
    type: string;
    most_recent_notification_id: string;
    page_min_id?: string;
    page_max_id?: string;
    latest_page_notification_at?: string;
    sample_account_ids: string[];
    status_id?: string;
    emojis?: { emoji: string; emoji_url: string | null }[];
};

type Grouped = {
    accounts: { id: string }[];
    partial_accounts?: Record<string, unknown>[];
    statuses: { id: string }[];
    notification_groups: Group[];
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

    /** alice's notification groups at `query`, each as its key, count and sampled accounts. */
    const groups = async (query = "") => {
        const { status, body } = await request("GET", `/api/v2/notifications${query}`);
        assertEquals(status, 200);

        return (body as Grouped).notification_groups.map((group) =>
            [group.group_key, group.notifications_count, group.sample_account_ids.join(",")]
                .join(" ")
        );
    };

    /** The ids of alice's notifications, newest first. */
    const ids = async () =>
        ((await request("GET", "/api/v1/notifications")).body as Shown[]).map((each) => each.id);

    return { ...test, request, list, post, groups, ids };
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
    assertEquals(
        (await test.request("POST", "/api/v2/notifications/a/dismiss", writing)).status,
        403,
    );
    assertEquals((await test.request("GET", "/api/v2/notifications/a", reading)).status, 403);
    assertEquals(
        (await test.request("GET", "/api/v2/notifications/a/accounts", reading)).status,
        403,
    );
});

Deno.test("grouped notifications have a group each, with its accounts and status", async () => {
    await using test = await open();
    const own = await test.post("alice", "Hi");
    await like(test.ctx, "bob", own.id);
    await like(test.ctx, "carol", own.id);
    await follow(test.ctx, "dave", "alice");
    const mention = await test.post("bob", "Hi @alice");
    const [mentioned, followed, carolLiked] = await test.ids();
    const hour = Math.floor(test.clock.now().getTime() / 3_600_000);

    const { body } = await test.request("GET", "/api/v2/notifications");
    const grouped = body as Grouped;
    assertEquals(grouped.notification_groups, [
        {
            group_key: `ungrouped-${mentioned}`,
            notifications_count: 1,
            type: "mention",
            most_recent_notification_id: mentioned ?? "",
            page_min_id: mentioned ?? "",
            page_max_id: mentioned ?? "",
            latest_page_notification_at: test.clock.now().toISOString(),
            sample_account_ids: ["bob"],
            status_id: mention.id,
        },
        {
            group_key: `follow--${hour}`,
            notifications_count: 1,
            type: "follow",
            most_recent_notification_id: followed ?? "",
            page_min_id: followed ?? "",
            page_max_id: followed ?? "",
            latest_page_notification_at: test.clock.now().toISOString(),
            sample_account_ids: ["dave"],
        },
        {
            group_key: `favourite-${own.id}-${hour}`,
            notifications_count: 2,
            type: "favourite",
            most_recent_notification_id: carolLiked ?? "",
            // bob's is older than the page, which ends at the newest of its last group.
            page_min_id: carolLiked ?? "",
            page_max_id: carolLiked ?? "",
            latest_page_notification_at: test.clock.now().toISOString(),
            sample_account_ids: ["carol", "bob"],
            status_id: own.id,
        },
    ]);
    assertEquals(grouped.accounts.map((account) => account.id), ["bob", "dave", "carol"]);
    assertEquals(grouped.statuses.map((status) => status.id), [mention.id, own.id]);
    assertEquals(grouped.partial_accounts, undefined);
});

Deno.test("with partial_avatars, only each group's newest account is in full", async () => {
    await using test = await open();
    const own = await test.post("alice", "Hi");
    await like(test.ctx, "bob", own.id);
    await like(test.ctx, "carol", own.id);
    await follow(test.ctx, "dave", "alice");

    const { body } = await test.request(
        "GET",
        "/api/v2/notifications?expand_accounts=partial_avatars",
    );
    const grouped = body as Grouped;
    assertEquals(grouped.accounts.map((account) => account.id), ["dave", "carol"]);
    assertEquals(grouped.partial_accounts?.map((account) => Object.keys(account).sort()), [
        ["acct", "avatar", "avatar_static", "bot", "id", "locked", "url"],
    ]);
    assertEquals(grouped.partial_accounts?.[0]?.id, "bob");

    const full = (await test.request("GET", "/api/v2/notifications")).body as Grouped;
    assertEquals(full.accounts.map((account) => account.id), ["dave", "carol", "bob"]);

    const asked = await test.request("GET", "/api/v2/notifications?expand_accounts=some");
    assertEquals(asked.status, 422);
});

Deno.test("only the types in grouped_types are grouped, and reactions only when asked", async () => {
    await using test = await open();
    await createLocalEmoji(test.ctx, "blob");
    const own = await test.post("alice", "Hi");
    await like(test.ctx, "bob", own.id);
    await like(test.ctx, "carol", own.id);
    await react(test.ctx, "bob", own.id, "🎉");
    await react(test.ctx, "bob", own.id, ":blob:");
    await react(test.ctx, "carol", own.id, "🎉");
    const [carolReacted, blobbed, bobReacted, carolLiked, bobLiked] = await test.ids();
    const hour = Math.floor(test.clock.now().getTime() / 3_600_000);
    const liked = `favourite-${own.id}-${hour} 2 carol,bob`;

    assertEquals(await test.groups(), [
        `ungrouped-${carolReacted} 1 carol`,
        `ungrouped-${blobbed} 1 bob`,
        `ungrouped-${bobReacted} 1 bob`,
        liked,
    ]);
    assertEquals(await test.groups("?grouped_types[]=favourite&grouped_types[]=reaction"), [
        `reaction-${own.id}-${hour} 3 carol,bob`,
        liked,
    ]);

    const ungrouped = [`ungrouped-${carolLiked} 1 carol`, `ungrouped-${bobLiked} 1 bob`];
    assertEquals((await test.groups("?grouped_types[]=reaction")).slice(1), ungrouped);
    assertEquals((await test.groups("?grouped_types[]=poll")).slice(3), ungrouped);

    const { body } = await test.request("GET", "/api/v2/notifications?grouped_types[]=reaction");
    const [reacted] = (body as Grouped).notification_groups;
    assertEquals(reacted?.status_id, own.id);
    assertEquals((body as Grouped).statuses.map((status) => status.id), [own.id]);
    assertEquals(reacted?.emojis, [
        { emoji: "🎉", emoji_url: null },
        { emoji: ":blob:", emoji_url: "https://social.example/media/emoji-blob" },
    ]);

    const each = (await test.request("GET", "/api/v2/notifications")).body as Grouped;
    assertEquals(each.notification_groups[1]?.emojis, [
        { emoji: ":blob:", emoji_url: "https://social.example/media/emoji-blob" },
    ]);
    assertEquals(each.notification_groups[3]?.emojis, undefined);
});

Deno.test("grouped notifications are paged by group, filtered, and leave out hidden accounts", async () => {
    await using test = await open();
    const own = await test.post("alice", "Hi");
    for (const id of ["bob", "carol", "dave"]) {
        await like(test.ctx, id, own.id);
        test.clock.advance(1000);
    }
    await follow(test.ctx, "bob", "alice");
    const [followed, daveLiked, , bobLiked] = await test.ids();
    const hour = Math.floor(test.clock.now().getTime() / 3_600_000);
    const liked = `favourite-${own.id}-${hour}`;

    const first = await test.request("GET", "/api/v2/notifications?limit=1");
    assertStringIncludes(first.link ?? "", `max_id=${followed}>; rel="next"`);
    assertStringIncludes(first.link ?? "", `min_id=${followed}>; rel="prev"`);
    assertEquals(await test.groups(`?max_id=${followed}`), [`${liked} 3 dave,carol,bob`]);
    assertEquals(await test.groups(`?max_id=${daveLiked}`), [`${liked} 2 carol,bob`]);

    // Counted up to the page's newest, but from its oldest in the page.
    const { body } = await test.request("GET", `/api/v2/notifications?since_id=${bobLiked}`);
    const [, group] = (body as Grouped).notification_groups;
    assertEquals([group?.notifications_count, group?.page_min_id], [3, daveLiked]);

    // After min_id, a group is found as its oldest, but shows its newest up to the page's.
    const after = await test.request("GET", "/api/v2/notifications?min_id=0&limit=2");
    const [, oldest] = (after.body as Grouped).notification_groups;
    assertEquals(
        [oldest?.most_recent_notification_id, oldest?.page_max_id, oldest?.page_min_id],
        [daveLiked, daveLiked, bobLiked],
    );
    assertEquals(
        oldest?.latest_page_notification_at,
        new Date(test.clock.now().getTime() - 1000).toISOString(),
    );

    assertEquals(await test.groups("?types[]=follow"), [`follow--${hour} 1 bob`]);
    // Counted up to carol's, the page's newest.
    assertEquals(await test.groups("?exclude_types[]=follow&account_id=carol"), [
        `${liked} 2 carol,bob`,
    ]);

    await block(test.ctx, "alice", "carol");
    assertEquals(await test.groups("?types[]=favourite"), [`${liked} 2 dave,bob`]);
});

Deno.test("grouped notifications take read:notifications", async () => {
    await using test = await open();
    const reading = { scopes: ["read:statuses" as const] };

    assertEquals((await test.request("GET", "/api/v2/notifications", reading)).status, 403);
    assertEquals((await test.request("GET", "/api/v2/notifications")).body, {
        accounts: [],
        statuses: [],
        notification_groups: [],
    });
});

Deno.test("a notification group is shown whole, without a page's ids", async () => {
    await using test = await open();
    const own = await test.post("alice", "Hi");
    await like(test.ctx, "bob", own.id);
    await like(test.ctx, "carol", own.id);
    await react(test.ctx, "bob", own.id, "🎉");
    const mention = await test.post("bob", "Hi @alice");
    const [mentioned, reacted, carolLiked] = await test.ids();
    const hour = Math.floor(test.clock.now().getTime() / 3_600_000);
    const show = (key: string) => test.request("GET", `/api/v2/notifications/${key}`);

    const liked = await show(`favourite-${own.id}-${hour}`);
    assertEquals(liked.status, 200);
    const grouped = liked.body as Grouped;
    assertEquals(grouped.accounts.map((account) => account.id), ["carol", "bob"]);
    assertEquals(grouped.statuses.map((status) => status.id), [own.id]);
    assertEquals(grouped, {
        ...grouped,
        notification_groups: [{
            group_key: `favourite-${own.id}-${hour}`,
            notifications_count: 2,
            type: "favourite",
            most_recent_notification_id: carolLiked,
            sample_account_ids: ["carol", "bob"],
            status_id: own.id,
        }],
    });

    // Grouped, though reactions aren't unless asked, when it's the key that is asked for.
    const [reaction] = (await show(`reaction-${own.id}-${hour}`)).body.notification_groups;
    assertEquals([reaction.notifications_count, reaction.emojis], [1, [
        { emoji: "🎉", emoji_url: null },
    ]]);

    const one = async (key: string) => {
        const [group] = (await show(key)).body.notification_groups as Group[];
        return [group?.group_key, group?.type, group?.notifications_count, group?.status_id];
    };
    assertEquals(await one(`ungrouped-${mentioned}`), [
        `ungrouped-${mentioned}`,
        "mention",
        1,
        mention.id,
    ]);
    assertEquals(await one(`ungrouped-${carolLiked}`), [
        `ungrouped-${carolLiked}`,
        "favourite",
        1,
        own.id,
    ]);
    assertEquals(await one(`ungrouped-${reacted}`), [
        `ungrouped-${reacted}`,
        "reaction",
        1,
        own.id,
    ]);
});

Deno.test("a notification group is not found if it isn't the user's, or they're shown none of it", async () => {
    await using test = await open();
    const own = await test.post("alice", "Hi");
    await like(test.ctx, "bob", own.id);
    const hour = Math.floor(test.clock.now().getTime() / 3_600_000);
    const key = `favourite-${own.id}-${hour}`;
    const [liked] = await test.ids();

    assertEquals((await test.request("GET", "/api/v2/notifications/nothing")).status, 404);
    assertEquals(
        (await test.request("GET", `/api/v2/notifications/${key}`, { as: "bob" })).status,
        404,
    );
    assertEquals(
        (await test.request("GET", `/api/v2/notifications/ungrouped-${liked}`, { as: "bob" }))
            .status,
        404,
    );

    await block(test.ctx, "alice", "bob");
    assertEquals((await test.request("GET", `/api/v2/notifications/${key}`)).status, 404);
});

Deno.test("a group's accounts are listed newest first, each once, a page at a time", async () => {
    await using test = await open();
    const own = await test.post("alice", "Hi");
    await react(test.ctx, "bob", own.id, "🎉");
    await react(test.ctx, "carol", own.id, "🎉");
    await react(test.ctx, "dave", own.id, "🎉");
    await react(test.ctx, "bob", own.id, "👍");
    // Newer, but in another group.
    await like(test.ctx, "bob", own.id);
    const [, bobReacted, daveReacted] = await test.ids();
    const hour = Math.floor(test.clock.now().getTime() / 3_600_000);
    const path = `/api/v2/notifications/reaction-${own.id}-${hour}/accounts`;
    const ids = async (query = "") =>
        ((await test.request("GET", `${path}${query}`)).body as { id: string }[])
            .map((account) => account.id);

    assertEquals(await ids(), ["bob", "dave", "carol"]);

    const first = await test.request("GET", `${path}?limit=1`);
    assertEquals(first.body.map((account: { id: string }) => account.id), ["bob"]);
    assertStringIncludes(first.link ?? "", `max_id=${bobReacted}>; rel="next"`);
    assertEquals(await ids(`?max_id=${daveReacted}`), ["carol"]);

    await block(test.ctx, "alice", "dave");
    assertEquals(await ids(), ["bob", "carol"]);

    const one = `/api/v2/notifications/ungrouped-${bobReacted}/accounts`;
    assertEquals((await test.request("GET", one)).body.map((a: { id: string }) => a.id), ["bob"]);
    assertEquals((await test.request("GET", path, { as: "bob" })).body, []);

    // carol's follow of bob is newer, and has the same key, but is bob's.
    await follow(test.ctx, "carol", "alice");
    await follow(test.ctx, "carol", "bob");
    const followers = await test.request("GET", `/api/v2/notifications/follow--${hour}/accounts`);
    assertEquals(followers.body.map((a: { id: string }) => a.id), ["carol"]);
});

Deno.test("dismissing a group deletes its notifications, and no one else's", async () => {
    await using test = await open();
    const own = await test.post("alice", "Hi");
    await like(test.ctx, "bob", own.id);
    await like(test.ctx, "carol", own.id);
    await follow(test.ctx, "dave", "alice");
    await follow(test.ctx, "dave", "bob");
    const [followed] = await test.ids();
    const hour = Math.floor(test.clock.now().getTime() / 3_600_000);
    const dismiss = (key: string, as?: string) =>
        test.request("POST", `/api/v2/notifications/${key}/dismiss`, { as });

    const dismissed = await dismiss(`favourite-${own.id}-${hour}`);
    assertEquals([dismissed.status, dismissed.body], [200, {}]);
    assertEquals(await test.list(), ["follow dave"]);

    // bob's follow notification has the same key as alice's.
    assertEquals((await dismiss(`ungrouped-${followed}`, "bob")).status, 200);
    assertEquals(await test.list(), ["follow dave"]);
    assertEquals((await dismiss(`follow--${hour}`, "bob")).status, 200);
    assertEquals(await test.list(), ["follow dave"]);

    assertEquals((await dismiss(`ungrouped-${followed}`)).status, 200);
    assertEquals(await test.list(), []);
    assertEquals((await test.request("GET", "/api/v1/notifications", { as: "bob" })).body, []);
    assertEquals((await dismiss("nothing")).status, 200);
});
