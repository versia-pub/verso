/**
 * What local users see of a suspended account through the client API: a blank profile, and none of
 * its statuses or follows, as on Mastodon.
 * @module
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import { updateProfile } from "../accounts/profile.ts";
import { createLocalAccount, createRole, giveRole } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { createLocalEmoji } from "../emojis/testing.ts";
import { follow } from "../graph/follows.ts";
import { routes } from "../http/routes.ts";
import { defaultSettings } from "../instances/testing.ts";
import { postNote } from "../notes/notes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { suspend, unsuspend } from "./suspensions.ts";

/**
 * alice, who follows carol, and carol, who has a full profile, a visible role and a status bob
 * replied to, and follows bob.
 */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, routes(defaultSettings()), { checkResponses: true });
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    await createLocalEmoji(test.ctx, "blob");
    await updateProfile(test.ctx, "carol", {
        displayName: "Carol :blob:",
        note: "Hello",
        fields: [{ name: "Site", value: "carol.example" }],
        locked: true,
        bot: true,
        discoverable: true,
        indexable: true,
    });
    const picture = (id: string, url: string | null, description: string) => ({
        id,
        instance_id: null,
        url,
        media_type: "image/png",
        sha256: id,
        preview_sha256: `${id}-still`,
        description,
        processed_at: test.ctx.clock.now(),
        created_at: test.ctx.clock.now(),
    });
    await test.ctx.db.insertInto("media")
        .values([
            picture("avatar", "https://pictures.example/carol.png", "A cat"),
            picture("header", null, "A hill"),
        ])
        .execute();
    await test.ctx.db.updateTable("accounts")
        .set({ avatar_id: "avatar", header_id: "header" })
        .where("id", "=", "carol")
        .execute();
    await createRole(test.ctx, "Admin", []);
    await test.ctx.db.updateTable("roles").set({ visible: true }).execute();
    await giveRole(test.ctx, "carol", "Admin");
    await follow(test.ctx, "alice", "carol");
    await follow(test.ctx, "carol", "bob");
    const draft = { format: "text/plain", spoilerText: "" } as const;
    const status = await postNote(test.ctx, "carol", { ...draft, text: "Hi" });
    const reply = await postNote(test.ctx, "bob", {
        ...draft,
        text: "Hi Carol",
        inReplyToId: status?.id,
    });
    const token = await tokenFor(test.ctx, "alice");

    /** Requests `path` as alice, or as no one if `signedIn` is false. */
    const request = async (method: string, path: string, signedIn = true) => {
        const response = await app.request(path, {
            method,
            headers: signedIn ? { authorization: `Bearer ${token}` } : {},
        });
        return { status: response.status, body: await response.json() };
    };

    return { ...test, request, statusId: status?.id ?? "", replyId: reply?.id ?? "" };
};

Deno.test("a suspended account is shown blank, and says so", async () => {
    await using test = await open();
    const before = (await test.request("GET", "/api/v1/accounts/carol")).body;
    assertEquals(
        [
            before.display_name,
            before.locked,
            before.bot,
            before.emojis.length,
            before.roles.length,
            before.avatar,
            before.avatar_description,
            before.header_description,
            before.suspended,
        ],
        [
            "Carol :blob:",
            true,
            true,
            1,
            1,
            "https://pictures.example/carol.png",
            "A cat",
            "A hill",
            undefined,
        ],
    );
    assertNotEquals(before.header, test.ctx.urls.url`/accounts/carol/header.png`);

    await suspend(test.ctx, "carol");
    const { status, body } = await test.request("GET", "/api/v1/accounts/carol");

    assertEquals(status, 200);
    assertEquals(
        {
            suspended: body.suspended,
            display_name: body.display_name,
            note: body.note,
            fields: body.fields,
            emojis: body.emojis,
            locked: body.locked,
            bot: body.bot,
            discoverable: body.discoverable,
            indexable: body.indexable,
            roles: body.roles,
            avatar: body.avatar,
            avatar_static: body.avatar_static,
            header: body.header,
            header_static: body.header_static,
            avatar_description: body.avatar_description,
            header_description: body.header_description,
        },
        {
            suspended: true,
            display_name: "",
            note: "",
            fields: [],
            emojis: [],
            locked: false,
            bot: false,
            discoverable: false,
            indexable: false,
            roles: [],
            avatar: test.ctx.urls.url`/accounts/carol/avatar.png`,
            avatar_static: test.ctx.urls.url`/accounts/carol/avatar.png`,
            header: test.ctx.urls.url`/accounts/carol/header.png`,
            header_static: test.ctx.urls.url`/accounts/carol/header.png`,
            avatar_description: "",
            header_description: "",
        },
    );
    // Its counts are kept, as on Mastodon.
    assertEquals([body.statuses_count, body.following_count], [1, 1]);

    await unsuspend(test.ctx, "carol");
    const after = (await test.request("GET", "/api/v1/accounts/carol")).body;
    assertEquals([after.display_name, after.suspended], ["Carol :blob:", undefined]);
});

Deno.test("a suspended account's statuses and follows aren't shown, and it can't be followed", async () => {
    await using test = await open();
    await suspend(test.ctx, "carol");

    for (const list of ["statuses", "followers", "following"]) {
        assertEquals(await test.request("GET", `/api/v1/accounts/carol/${list}`), {
            status: 200,
            body: [],
        }, list);
    }
    assertEquals((await test.request("POST", "/api/v1/accounts/carol/follow")).status, 404);

    assertEquals((await test.request("GET", `/api/v1/statuses/${test.statusId}`)).status, 404);
    assertEquals(
        (await test.request("POST", `/api/v1/statuses/${test.statusId}/favourite`)).status,
        404,
    );
    const context = (await test.request("GET", `/api/v1/statuses/${test.replyId}/context`)).body;
    assertEquals(context.ancestors, []);
    const seenByNoOne = await test.request(
        "GET",
        `/api/v1/statuses/${test.replyId}/context`,
        false,
    );
    assertEquals(seenByNoOne, { status: 200, body: { ancestors: [], descendants: [] } });

    await unsuspend(test.ctx, "carol");
    assertEquals((await test.request("GET", `/api/v1/statuses/${test.statusId}`)).status, 200);
    const shownToNoOne = await test.request(
        "GET",
        `/api/v1/statuses/${test.replyId}/context`,
        false,
    );
    assertEquals(shownToNoOne.body.ancestors.length, 1);
    assertEquals(
        (await test.request("GET", "/api/v1/accounts/carol/following")).body.length,
        1,
    );
});

Deno.test("relationships leave out suspended accounts, unless asked for them", async () => {
    await using test = await open();
    await suspend(test.ctx, "carol");

    const ids = (query: string) =>
        test.request("GET", `/api/v1/accounts/relationships?id[]=bob&id[]=carol${query}`)
            .then(({ body }) => body.map((found: { id: string }) => found.id));

    assertEquals(await ids(""), ["bob"]);
    assertEquals(await ids("&with_suspended=false"), ["bob"]);
    assertEquals(await ids("&with_suspended=true"), ["bob", "carol"]);
    // One account's relationship, after unfollowing it, is still given.
    const unfollowed = await test.request("POST", "/api/v1/accounts/carol/unfollow");
    assertEquals([unfollowed.status, unfollowed.body.following], [200, false]);
});
