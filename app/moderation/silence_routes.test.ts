/**
 * What local users see of a silenced account through the client API: all of it, said to be
 * limited, but none of its statuses on the public timelines, as on Mastodon.
 * @module
 */
import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { follow } from "../graph/follows.ts";
import { routes } from "../http/routes.ts";
import { defaultSettings } from "../instances/testing.ts";
import { postNote } from "../notes/notes.ts";
import { indexUnindexedAccounts } from "../search/accounts.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { silence, unsilence } from "./silences.ts";

Deno.test("a silenced account is said to be limited, and its statuses kept off the public timelines", async () => {
    await using test = await createTestContext();
    const app = createTestApp(test.ctx, routes(defaultSettings()), { checkResponses: true });
    for (const id of ["alice", "carol"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "alice", "carol");
    for (const [id, text] of [["alice", "#cats"], ["carol", "#cats"]]) {
        await postNote(test.ctx, id, { format: "text/plain", spoilerText: "", text });
    }
    await indexUnindexedAccounts(test.ctx);
    const token = await tokenFor(test.ctx, "alice");

    /** What alice is shown of carol, and who wrote the statuses at each path. */
    const shown = async () => {
        const get = async (path: string) =>
            await (await app.request(path, { headers: { authorization: `Bearer ${token}` } }))
                .json();
        const authors = async (path: string) =>
            ((await get(path)) as { account: { id: string } }[])
                .map((status) => status.account.id).toSorted();
        const account = await get("/api/v1/accounts/carol");

        return {
            limited: account.limited,
            username: account.username,
            public: await authors("/api/v1/timelines/public"),
            tag: await authors("/api/v1/timelines/tag/cats"),
            home: await authors("/api/v1/timelines/home"),
            statuses: await authors("/api/v1/accounts/carol/statuses"),
            search: ((await get("/api/v2/search?q=caro&type=accounts")) as {
                accounts: { id: string }[];
            }).accounts.map((each) => each.id),
        };
    };

    const before = await shown();
    assertEquals(before, {
        limited: undefined,
        username: "carol",
        public: ["alice", "carol"],
        tag: ["alice", "carol"],
        home: ["alice", "carol"],
        statuses: ["carol"],
        search: ["carol"],
    });

    // Even to those who follow it, as on Mastodon.
    await silence(test.ctx, "carol");
    assertEquals(await shown(), {
        ...before,
        limited: true,
        public: ["alice"],
        tag: ["alice"],
    });

    await unsilence(test.ctx, "carol");
    assertEquals(await shown(), before);
});
