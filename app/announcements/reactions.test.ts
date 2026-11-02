import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { createLocalEmoji } from "../emojis/testing.ts";
import { subscribe } from "../kernel/pubsub.ts";
import { createTestContext } from "../testing/context.ts";
import { reactionsOf } from "./reaction_queries.ts";
import {
    announcementReacted,
    type AnnouncementReactedMessage,
    reactionLimit,
    reactToAnnouncement,
    unreactToAnnouncement,
} from "./reactions.ts";
import { removeAnnouncement, unpublishAnnouncement } from "./announcements.ts";
import { announce } from "./testing.ts";

/** alice and bob, local users, and what is published on {@link announcementReacted}. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    const heard: AnnouncementReactedMessage[] = [];
    subscribe(test.ctx, announcementReacted, (message) => {
        heard.push(message);
        return Promise.resolve();
    });

    /** The reactions to an announcement, as `name count me`, as `viewerId` sees them. */
    const reactions = async (id: string, viewerId: string | null) =>
        ((await reactionsOf(test.ctx, [id], viewerId)).get(id) ?? []).map((group) =>
            `${group.text ?? group.shortcode} ${group.count} ${group.me}`
        );

    return { ...test, heard, reactions };
};

Deno.test("users react to announcements once with each Unicode or local custom emoji", async () => {
    await using test = await open();
    const emojiId = await createLocalEmoji(test.ctx, "verso");
    const { id } = await announce(test.ctx, "Hi");

    assertEquals(await reactToAnnouncement(test.ctx, "alice", id, "👍"), "reacted");
    assertEquals(await reactToAnnouncement(test.ctx, "bob", id, "verso"), "reacted");
    assertEquals(await reactToAnnouncement(test.ctx, "alice", id, "verso"), "reacted");
    assertEquals(await reactToAnnouncement(test.ctx, "bob", id, "👍"), "reacted");
    assertEquals(await reactToAnnouncement(test.ctx, "alice", id, "👍"), "duplicate");
    assertEquals(await reactToAnnouncement(test.ctx, "alice", id, "verso"), "duplicate");

    // In the order each emoji was first used.
    assertEquals(await test.reactions(id, "alice"), ["👍 2 true", "verso 2 true"]);
    assertEquals(await test.reactions(id, "bob"), ["👍 2 true", "verso 2 true"]);
    assertEquals(await test.reactions(id, null), ["👍 2 false", "verso 2 false"]);
    assertEquals(test.heard, [
        { announcementId: id, name: "👍", emojiId: null },
        { announcementId: id, name: "verso", emojiId },
        { announcementId: id, name: "verso", emojiId },
        { announcementId: id, name: "👍", emojiId: null },
    ]);
});

Deno.test("only Unicode emojis and the local instance's global ones are reactions", async () => {
    await using test = await open();
    await createLocalEmoji(test.ctx, "verso");
    const { id } = await announce(test.ctx, "Hi");

    for (const name of ["verso!", ":verso:", "nobody", "ab", "👍👍", "", " "]) {
        assertEquals(await reactToAnnouncement(test.ctx, "alice", id, name), "unknown emoji", name);
    }
    assertEquals(await reactToAnnouncement(test.ctx, "alice", id, "👍🏽"), "reacted");
    assertEquals(await test.reactions(id, "alice"), ["👍🏽 1 true"]);
    assertEquals(test.heard.length, 1);
});

Deno.test("only published announcements can be reacted to", async () => {
    await using test = await open();
    const { id } = await announce(test.ctx, "Hi");
    const later = await announce(test.ctx, "Later", { scheduledAt: new Date("2027-01-01") });

    assertEquals(await reactToAnnouncement(test.ctx, "alice", later.id, "👍"), "missing");
    assertEquals(await reactToAnnouncement(test.ctx, "alice", "nothing", "👍"), "missing");
    assertEquals(await reactToAnnouncement(test.ctx, "alice", id, "👍"), "reacted");

    // Undoing needs it published too.
    await unpublishAnnouncement(test.ctx, id);
    assertEquals(await reactToAnnouncement(test.ctx, "alice", id, "😀"), "missing");
    assertEquals(await unreactToAnnouncement(test.ctx, "alice", id, "👍"), false);
    assertEquals(test.heard.length, 1);
});

Deno.test("an announcement's reactions are made with only a few different emojis", async () => {
    await using test = await open();
    const { id } = await announce(test.ctx, "Hi");
    const emojis = ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆", "😉"];
    assertEquals(reactionLimit, 8);

    for (const emoji of emojis.slice(0, reactionLimit)) {
        assertEquals(await reactToAnnouncement(test.ctx, "alice", id, emoji), "reacted");
    }
    const ninth = emojis[reactionLimit];
    assertEquals(await reactToAnnouncement(test.ctx, "alice", id, ninth), "limit reached");
    assertEquals(await reactToAnnouncement(test.ctx, "bob", id, ninth), "limit reached");
    // One already reacted with is not a new one.
    assertEquals(await reactToAnnouncement(test.ctx, "bob", id, emojis[3]), "reacted");
    assertEquals((await test.reactions(id, null)).length, reactionLimit);

    // Room is made when nobody reacts with an emoji any more.
    assertEquals(await unreactToAnnouncement(test.ctx, "alice", id, emojis[0]), true);
    assertEquals(await reactToAnnouncement(test.ctx, "bob", id, ninth), "reacted");
    assertEquals(await unreactToAnnouncement(test.ctx, "alice", id, emojis[3]), true);
    assertEquals(await reactToAnnouncement(test.ctx, "alice", id, emojis[0]), "limit reached");
});

Deno.test("a reaction is undone by whoever made it, and says so", async () => {
    await using test = await open();
    const emojiId = await createLocalEmoji(test.ctx, "verso");
    const { id } = await announce(test.ctx, "Hi");
    await reactToAnnouncement(test.ctx, "alice", id, "👍");
    await reactToAnnouncement(test.ctx, "bob", id, "👍");
    await reactToAnnouncement(test.ctx, "bob", id, "verso");
    test.heard.length = 0;

    assertEquals(await unreactToAnnouncement(test.ctx, "alice", id, "verso"), false);
    assertEquals(await unreactToAnnouncement(test.ctx, "alice", id, "nobody"), false);
    assertEquals(await unreactToAnnouncement(test.ctx, "alice", "nothing", "👍"), false);
    assertEquals(test.heard, []);

    assertEquals(await unreactToAnnouncement(test.ctx, "alice", id, "👍"), true);
    assertEquals(await unreactToAnnouncement(test.ctx, "alice", id, "👍"), false);
    assertEquals(await unreactToAnnouncement(test.ctx, "bob", id, "verso"), true);
    assertEquals(await test.reactions(id, null), ["👍 1 false"]);
    assertEquals(test.heard, [
        { announcementId: id, name: "👍", emojiId: null },
        { announcementId: id, name: "verso", emojiId },
    ]);
});

Deno.test("reactions go with their announcement, their account and their custom emoji", async () => {
    await using test = await open();
    const emojiId = await createLocalEmoji(test.ctx, "verso");
    const kept = await announce(test.ctx, "Kept");
    const removed = await announce(test.ctx, "Removed");
    for (const { id } of [kept, removed]) {
        await reactToAnnouncement(test.ctx, "alice", id, "verso");
        await reactToAnnouncement(test.ctx, "bob", id, "👍");
    }

    await removeAnnouncement(test.ctx, removed.id);
    assertEquals(await test.reactions(removed.id, null), []);
    assertEquals(await test.reactions(kept.id, null), ["verso 1 false", "👍 1 false"]);

    await test.ctx.db.deleteFrom("accounts").where("id", "=", "bob").execute();
    assertEquals(await test.reactions(kept.id, null), ["verso 1 false"]);

    await test.ctx.db.deleteFrom("emojis").where("id", "=", emojiId).execute();
    assertEquals(await test.reactions(kept.id, null), []);
});
