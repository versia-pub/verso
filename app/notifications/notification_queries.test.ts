import { assertEquals } from "@std/assert";
import type { KyselyPlugin } from "kysely";
import { createLocalAccount } from "../accounts/testing.ts";
import { block } from "../graph/blocks.ts";
import { follow } from "../graph/follows.ts";
import { like } from "../interactions/likes.ts";
import { react } from "../interactions/reactions.ts";
import type { PageBounds } from "../db/paging.ts";
import { postNote } from "../notes/notes.ts";
import { createTestContext } from "../testing/context.ts";
import { groupKeyOf, groupStatsOf, notificationGroupPage } from "./group_queries.ts";
import { insertNotifications, type NotificationFilter } from "./notification_queries.ts";
import { shownOf } from "./render.ts";
import type { NotificationType } from "./tables.ts";

/** Mastodon's default `grouped_types`. */
const byDefault: NotificationType[] = ["favourite", "follow", "reblog"];

/** Ten accounts, `u0` to `u9`. */
const many = Array.from({ length: 10 }, (_, n) => `u${n}`);

const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "carol", ...many]) await createLocalAccount(test.ctx, id);

    const note = await postNote(test.ctx, "alice", {
        text: "Hi",
        format: "text/plain",
        spoilerText: "",
    });
    if (note === undefined) throw new Error("Not posted");

    /** alice's groups, each as its type and who caused the notification it is shown as. */
    const groups = async (
        page: Partial<PageBounds> = {},
        grouped = byDefault,
        filter: NotificationFilter = {},
    ) => (await notificationGroupPage(
        test.ctx,
        "alice",
        shownOf(test.ctx, "alice"),
        filter,
        grouped,
        { limit: 40, ...page },
    )).map((row) => `${row.type} ${row.from_account_id}`);

    /** The ids of `accountId`'s notifications, by their type and who caused them. */
    const ids = async (accountId = "alice") =>
        new Map(
            (await test.ctx.db.selectFrom("notifications").selectAll()
                .where("account_id", "=", accountId)
                .execute())
                .map((row) => [`${row.type} ${row.from_account_id}`, row]),
        );

    /** Runs `run` with a context that counts the queries it makes, and returns how many. */
    const queriesOf = async (run: (ctx: typeof test.ctx) => Promise<unknown>) => {
        let queries = 0;
        const counter: KyselyPlugin = {
            transformQuery: ({ node }) => node,
            // Once a query is run, unlike `transformQuery`, which subqueries go through too.
            transformResult: ({ result }) => {
                queries += 1;
                return Promise.resolve(result);
            },
        };

        await run({ ...test.ctx, db: test.ctx.db.withPlugin(counter) });
        return queries;
    };

    return { ...test, note, groups, ids, queriesOf };
};

Deno.test("a page of groups has the newest notification of each, and its limit counts groups", async () => {
    await using test = await open();
    await like(test.ctx, "u0", test.note.id);
    await follow(test.ctx, "bob", "alice");
    for (const id of many.slice(1)) await like(test.ctx, id, test.note.id);

    assertEquals(await test.groups({ limit: 2 }), ["favourite u9", "follow bob"]);
    assertEquals(await test.groups({ limit: 3 }), ["favourite u9", "follow bob"]);
});

Deno.test("each query for a page of groups finds a group, until the page is full or read", async () => {
    await using test = await open();
    await follow(test.ctx, "bob", "alice");
    for (const id of many) await like(test.ctx, id, test.note.id);

    const pageOf = (limit: number) => (ctx: typeof test.ctx) =>
        notificationGroupPage(ctx, "alice", shownOf(ctx, "alice"), {}, byDefault, { limit });

    // The likes after the first are left out, and the last part, with fewer, ends the page.
    assertEquals(await test.queriesOf(pageOf(2)), 2);
    assertEquals(await test.queriesOf(pageOf(3)), 2);
});

Deno.test("each part of a page of groups reads twice as many notifications as the last", async () => {
    await using test = await open();
    // Ten groups of ten, one after another.
    await insertNotifications(
        test.ctx,
        Array.from({ length: 100 }, (_, n) => ({
            id: test.ctx.ids(),
            account_id: "alice",
            type: "follow",
            from_account_id: many[n % 10],
            note_id: null,
            share_id: null,
            like_id: null,
            reaction_id: null,
            follow_id: null,
            group_key: `follow-${Math.floor(n / 10)}`,
            created_at: test.ctx.clock.now(),
        })),
    );

    const page = (limit: number) => (ctx: typeof test.ctx) =>
        notificationGroupPage(ctx, "alice", shownOf(ctx, "alice"), {}, byDefault, { limit });
    const keys = async (limit: number) => (await page(limit)(test.ctx)).map((row) => row.group_key);

    // Of 10, 20, 40 and 80 notifications: a group, two, four, and the last three.
    assertEquals(await test.queriesOf(page(10)), 4);
    // The last part has two groups, of which the page has room for one.
    assertEquals(await keys(3), ["follow-9", "follow-8", "follow-7"]);
    assertEquals(await keys(10), [
        "follow-9",
        "follow-8",
        "follow-7",
        "follow-6",
        "follow-5",
        "follow-4",
        "follow-3",
        "follow-2",
        "follow-1",
        "follow-0",
    ]);
});

Deno.test("only the types asked for are grouped, and others are a group each", async () => {
    await using test = await open();
    for (const id of ["u0", "u1"]) await like(test.ctx, id, test.note.id);
    for (const id of ["bob", "carol"]) await react(test.ctx, id, test.note.id, "🎉");
    const each = ["reaction carol", "reaction bob", "favourite u1", "favourite u0"];

    assertEquals(await test.groups(), each.slice(0, 3));
    assertEquals(await test.groups({}, ["reaction"]), ["reaction carol", ...each.slice(2)]);
    assertEquals(await test.groups({}, []), each);
    assertEquals(await test.groups({ limit: 3 }, ["favourite", "reaction"]), [
        "reaction carol",
        "favourite u1",
    ]);
});

Deno.test("a notification of a grouped type without a key is a group of its own", async () => {
    await using test = await open();
    for (const id of ["u0", "u1", "u2"]) await like(test.ctx, id, test.note.id);
    await test.ctx.db.updateTable("notifications").set({ group_key: null })
        .where("from_account_id", "=", "u0")
        .execute();

    // Found after the group, in a part that leaves the group out.
    assertEquals(await test.groups({ limit: 2 }), ["favourite u2", "favourite u0"]);
});

Deno.test("after min_id, groups are found oldest first, as their oldest notification", async () => {
    await using test = await open();
    for (const id of ["u0", "u1", "u2"]) await like(test.ctx, id, test.note.id);
    await follow(test.ctx, "bob", "alice");
    await follow(test.ctx, "carol", "alice");

    assertEquals(await test.groups({ min_id: "0", limit: 2 }), ["follow bob", "favourite u0"]);

    const u0 = (await test.ids()).get("favourite u0")?.id;
    assertEquals(await test.groups({ min_id: u0, limit: 1 }), ["favourite u1"]);
    assertEquals(await test.groups({ max_id: u0 }), []);
});

Deno.test("a page of groups leaves out what the user is not shown, and what the filter omits", async () => {
    await using test = await open();
    for (const id of ["u0", "u1"]) await like(test.ctx, id, test.note.id);
    await follow(test.ctx, "bob", "alice");
    await block(test.ctx, "alice", "u1");

    assertEquals(await test.groups(), ["follow bob", "favourite u0"]);
    assertEquals(await test.groups({}, byDefault, { types: [] }), []);
    assertEquals(await test.groups({}, byDefault, { types: ["follow"] }), ["follow bob"]);
});

Deno.test("a group's stats count up to the page's newest, and sample 8 accounts", async () => {
    await using test = await open();
    await follow(test.ctx, "bob", "carol");
    await follow(test.ctx, "u9", "carol");
    for (const id of many.slice(0, 6)) await like(test.ctx, id, test.note.id);
    await follow(test.ctx, "bob", "alice");
    for (const id of many.slice(6)) await like(test.ctx, id, test.note.id);
    await follow(test.ctx, "carol", "alice");
    const ids = await test.ids();
    const id = (key: string) => ids.get(key)?.id ?? "";
    const groupOf = (key: string) => ids.get(key)?.group_key ?? "";

    const stats = await groupStatsOf(
        test.ctx,
        "alice",
        shownOf(test.ctx, "alice"),
        [groupOf("favourite u0"), groupOf("follow bob")],
        { oldest: id("favourite u5"), newest: id("favourite u7") },
    );
    const liked = stats.get(groupOf("favourite u0"));

    assertEquals(liked?.count, 8);
    assertEquals(liked?.pageMinId, id("favourite u5"));
    assertEquals(
        liked?.samples.map((sample) => sample.from_account_id),
        ["u7", "u6", "u5", "u4", "u3", "u2", "u1", "u0"],
    );
    assertEquals(liked?.samples[0]?.created_at, ids.get("favourite u7")?.created_at);
    assertEquals(liked?.reactionIds, []);

    // Not carol's, though theirs has the same key, nor what is newer than the page.
    const followed = stats.get(groupOf("follow bob"));
    assertEquals(followed?.count, 1);
    assertEquals(followed?.samples.map((sample) => sample.from_account_id), ["bob"]);
});

Deno.test("a group's samples are 8 different accounts, and its count each notification", async () => {
    await using test = await open();
    const other = await postNote(test.ctx, "alice", {
        text: "Hi again",
        format: "text/plain",
        spoilerText: "",
    });
    if (other === undefined) throw new Error("Not posted");

    await react(test.ctx, "bob", other.id, "🎉");
    for (const id of many) await react(test.ctx, id, test.note.id, "🎉");
    await react(test.ctx, "u0", test.note.id, "👍");
    await react(test.ctx, "u0", test.note.id, "👀");
    await like(test.ctx, "u1", test.note.id);
    await block(test.ctx, "alice", "u9");

    const rows = await test.ctx.db.selectFrom("notifications").selectAll()
        .where("account_id", "=", "alice")
        .orderBy("id", "desc")
        .execute();
    const [newest, oldest] = [rows.at(0), rows.at(-1)];
    if (newest === undefined || oldest === undefined) throw new Error("Not notified");

    const reacted = rows.filter((row) => row.note_id === test.note.id && row.type === "reaction");
    const key = groupKeyOf(reacted[0] ?? newest, ["reaction"]);
    const otherKey = groupKeyOf(oldest, ["reaction"]);
    const stats = await groupStatsOf(
        test.ctx,
        "alice",
        shownOf(test.ctx, "alice"),
        [key, otherKey],
        { oldest: oldest.id, newest: newest.id },
    );
    const reactions = await test.ctx.db.selectFrom("reactions").select(["id", "note_id"])
        .orderBy("id", "desc")
        .execute();
    const reactionsTo = (noteId: string) =>
        reactions.filter((reaction) => reaction.note_id === noteId).map((reaction) => reaction.id);

    // Only the groups asked for, so not u1's like.
    assertEquals([...stats.keys()].sort(), [key, otherKey].sort());

    const group = stats.get(key);
    assertEquals(group?.count, 11);
    assertEquals(group?.pageMinId, reacted.at(-1)?.id);
    assertEquals(
        group?.samples.map((sample) => sample.from_account_id),
        ["u0", "u8", "u7", "u6", "u5", "u4", "u3", "u2"],
    );
    // The 8 newest, but u9's, whom alice blocks.
    assertEquals(
        group?.reactionIds,
        reactionsTo(test.note.id).filter((_, n) => n !== 2).slice(0, 8),
    );

    assertEquals(stats.get(otherKey)?.reactionIds, reactionsTo(other.id));
    assertEquals(stats.get(otherKey)?.samples.map((sample) => sample.from_account_id), ["bob"]);
});

Deno.test("no groups have no stats", async () => {
    await using test = await open();
    const page = { oldest: "0", newest: "z" };

    assertEquals(
        await groupStatsOf(test.ctx, "alice", shownOf(test.ctx, "alice"), [], page),
        new Map(),
    );
});
