/**
 * Media attachments end to end, between complete instances, through the client API: a status's
 * media reaching followers on another instance, served by the instance that stores it, edited, and
 * removed once the status is deleted.
 * @module
 */
import { assertEquals } from "@std/assert";
import { encode } from "fast-png";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { tasks } from "../jobs/queues.ts";
import { schedule } from "../jobs/scheduler.ts";
import { clientOf, followAddress } from "../testing/clients.ts";
import { createNetwork } from "../testing/network.ts";

const png = new Uint8Array(encode({
    width: 2,
    height: 2,
    data: new Uint8Array(16).fill(200),
    channels: 4,
}));

const day = 24 * 60 * 60 * 1000;

Deno.test("a status's media reaches followers on another instance, edited, until it is deleted", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    const b = network.instances["b.test"];
    const aliceId = await createLocalAccount(a.ctx, "alice");
    const alice = await clientOf(a, aliceId);
    const bob = await clientOf(b, await createLocalAccount(b.ctx, "bob"));
    await followAddress(bob, "alice@a.test");
    await network.drain();

    const form = new FormData();
    form.append("file", new File([png], "red.png", { type: "image/png" }));
    form.append("description", "A square");
    const uploaded = await a.app.request("/api/v2/media", {
        method: "POST",
        headers: { authorization: `Bearer ${await tokenFor(a.ctx, aliceId)}` },
        body: form,
    });
    const { id: mediaId } = await uploaded.json();
    await network.drain();

    const posted = await alice("POST", "/api/v1/statuses", {
        status: "Look",
        media_ids: [mediaId],
    });
    await network.drain();
    const [local] = posted.body.media_attachments;

    /** Bob's view of alice's status. */
    const seen = async () => {
        const home = await bob("GET", "/api/v1/timelines/home");
        return home.body.find((status: { content: string }) => status.content.includes("Look"));
    };

    const [remote] = (await seen()).media_attachments;
    assertEquals(
        [remote.type, remote.url, remote.remote_url, remote.description],
        ["image", local.url, local.url, "A square"],
    );
    const served = await a.app.request(remote.url);
    assertEquals([served.status, served.headers.get("content-type")], [200, "image/png"]);
    await served.body?.cancel();

    await alice("PUT", `/api/v1/statuses/${posted.body.id}`, {
        status: "Look",
        media_ids: [mediaId],
        media_attributes: [{ id: mediaId, description: "A red square" }],
    });
    await network.drain();

    const edited = await seen();
    assertEquals(edited.media_attachments[0].description, "A red square");
    const history = await bob("GET", `/api/v1/statuses/${edited.id}/history`);
    assertEquals(
        history.body.map((version: { media_attachments: { description: string }[] }) =>
            version.media_attachments.map((media) => media.description)
        ),
        [["A square"], ["A red square"]],
    );

    await alice("DELETE", `/api/v1/statuses/${posted.body.id}`);
    await network.drain();
    network.clock.advance(day);
    await schedule(b.ctx, tasks);
    await network.drain();

    // Only alice's avatar and header are left.
    const left = await b.ctx.db.selectFrom("media").select("url").orderBy("url").execute();
    assertEquals(left.map((row) => row.url), [
        "https://a.test/accounts/alice/avatar.png",
        "https://a.test/accounts/alice/header.png",
    ]);
});
