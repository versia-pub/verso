/**
 * Notifications end to end, between complete instances, through the client API: a remote user's
 * reply, with media and their own custom emoji, and their like, notifying the status's author, and
 * a blocked account's notifications not showing until the block is lifted.
 * @module
 */
import { assertEquals } from "@std/assert";
import { encode } from "fast-png";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { clientOf, followAddress } from "../testing/clients.ts";
import { createNetwork, type Instance } from "../testing/network.ts";

const png = new Uint8Array(encode({
    width: 2,
    height: 2,
    data: new Uint8Array(16).fill(200),
    channels: 4,
}));

/** Alice on a.test, with a status, and bob on b.test, who follows her and has it. */
const open = async () => {
    const network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    const b = network.instances["b.test"];
    const alice = await clientOf(a, await createLocalAccount(a.ctx, "alice"));
    const bobId = await createLocalAccount(b.ctx, "bob");
    const bob = await clientOf(b, bobId);
    await followAddress(bob, "alice@a.test");
    await network.drain();

    await alice("POST", "/api/v1/statuses", { status: "Hello" });
    await network.drain();
    const home = await bob("GET", "/api/v1/timelines/home");
    const status = home.body.find((seen: { content: string }) => seen.content.includes("Hello"));

    /** Sends `form` to `path` on `instance` as `accountId`, and returns what was made. */
    const upload = async (instance: Instance, accountId: string, path: string, form: FormData) => {
        const response = await instance.app.request(path, {
            method: "POST",
            headers: { authorization: `Bearer ${await tokenFor(instance.ctx, accountId)}` },
            body: form,
        });
        assertEquals(response.ok, true, path);
        const made = await response.json();
        await network.drain();
        return made;
    };

    /** Alice's notifications, newest first, as each one's type and account. */
    const notified = async () => {
        const notifications = await alice("GET", "/api/v1/notifications");
        return notifications.body.map((
            notification: { type: string; account: { acct: string } },
        ) => [notification.type, notification.account.acct]);
    };

    return {
        network,
        a,
        b,
        alice,
        bob,
        bobId,
        statusId: status.id as string,
        upload,
        notified,
        [Symbol.asyncDispose]: () => network[Symbol.asyncDispose](),
    };
};

Deno.test("a remote reply with media and its author's own emoji, and a like, notify the status's author", async () => {
    await using test = await open();
    const emoji = new FormData();
    emoji.append("shortcode", "blobfox");
    emoji.append("element", new File([png], "blobfox.png", { type: "image/png" }));
    await test.upload(test.b, test.bobId, "/api/v1/emojis", emoji);
    const media = new FormData();
    media.append("file", new File([png], "red.png", { type: "image/png" }));
    media.append("description", "A square");
    const { id: mediaId } = await test.upload(test.b, test.bobId, "/api/v2/media", media);

    const replied = await test.bob("POST", "/api/v1/statuses", {
        status: "@alice@a.test Look :blobfox:",
        in_reply_to_id: test.statusId,
        media_ids: [mediaId],
    });
    assertEquals(replied.status, 200);
    assertEquals(
        (await test.bob("POST", `/api/v1/statuses/${test.statusId}/favourite`)).status,
        200,
    );
    await test.network.drain();

    assertEquals(await test.notified(), [
        ["favourite", "bob@b.test"],
        ["mention", "bob@b.test"],
        ["follow", "bob@b.test"],
    ]);

    // Served by b.test, where they are kept.
    const [, mention] = (await test.alice("GET", "/api/v1/notifications")).body;
    const [attachment] = mention.status.media_attachments;
    const [blobfox] = mention.status.emojis;
    assertEquals([attachment.type, attachment.description], ["image", "A square"]);
    assertEquals(blobfox.shortcode, "blobfox");
    for (const url of [attachment.url, blobfox.url, blobfox.static_url]) {
        assertEquals(new URL(url).host, "b.test", url);
        const served = await test.b.app.request(url);
        assertEquals(served.status, 200, url);
        await served.body?.cancel();
    }
});

Deno.test("a blocked account's mention and like don't show as notifications until the block is lifted", async () => {
    await using test = await open();
    const bob = await test.alice("GET", "/api/v1/accounts/lookup?acct=bob@b.test");
    assertEquals((await test.alice("POST", `/api/v1/accounts/${bob.body.id}/block`)).status, 200);
    await test.network.drain();

    await test.bob("POST", "/api/v1/statuses", {
        status: "@alice@a.test Hi",
        in_reply_to_id: test.statusId,
    });
    await test.bob("POST", `/api/v1/statuses/${test.statusId}/favourite`);
    await test.network.drain();
    assertEquals(await test.notified(), []);

    assertEquals((await test.alice("POST", `/api/v1/accounts/${bob.body.id}/unblock`)).status, 200);
    // Bob's follow too, from before.
    assertEquals(await test.notified(), [
        ["favourite", "bob@b.test"],
        ["mention", "bob@b.test"],
        ["follow", "bob@b.test"],
    ]);
});
