/**
 * The federation engine end to end, between complete instances: finding users, delivering to them,
 * peers going down, forged authors and blocks.
 * @module
 */
import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { updateProfile } from "../accounts/profile.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { Context } from "../kernel/context.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { registry } from "../registry.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork, type Network } from "../testing/network.ts";
import { type DeliverJob, deliverQueue, queueDeliveries } from "./deliver.ts";

const minute = 60_000;

/** The local user `id` as a Versia User. */
const userOf = async (ctx: Context, id: string) => {
    const user = await registry.types.get("User")?.find?.(ctx, id, "");
    assertExists(user);
    return user;
};

/** The remote accounts `ctx` has stored, by username, with their display names. */
const remoteNames = async (ctx: Context) =>
    Object.fromEntries(
        (await ctx.db.selectFrom("accounts").select(["username", "display_name"])
            .where("instance_id", "is not", null).execute())
            .map((row) => [row.username, row.display_name]),
    );

/** The requests sent to `host`, in total, or only to its inbox. */
const sentTo = (network: Network, host: string, path?: string) =>
    network.transport.sent.filter((request) => {
        const url = new URL(request.url);
        return url.host === host && (path === undefined || url.pathname === path);
    }).length;

const inbox = "/.versia/v0.6/inbox";

Deno.test("a user found by address is followed, and their followers see profile changes", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    const b = network.instances["b.test"];
    const alice = await createLocalAccount(a.ctx, "alice");
    const bob = await createLocalAccount(b.ctx, "bob");
    const asBob = { authorization: `Bearer ${await tokenFor(b.ctx, bob)}` };

    // bob looks alice up, so b.test fetches her, and follows her.
    const lookup = await b.app.request("/api/v1/accounts/lookup?acct=alice@a.test", {
        headers: asBob,
    });
    assertEquals(lookup.status, 200);
    const aliceOnB: string = (await lookup.json()).id;
    const asked = await b.app.request(`/api/v1/accounts/${aliceOnB}/follow`, {
        method: "POST",
        headers: asBob,
    });
    assertEquals((await asked.json()).requested, true);
    await network.drain();

    const relationship = await b.app.request(`/api/v1/accounts/relationships?id=${aliceOnB}`, {
        headers: asBob,
    });
    assertEquals((await relationship.json())[0].following, true);
    assertEquals(await remoteNames(b.ctx), { alice: "" });

    // alice changes her name, and her follower's instance is sent the update.
    const updated = await a.app.request("/api/v1/accounts/update_credentials", {
        method: "PATCH",
        headers: {
            authorization: `Bearer ${await tokenFor(a.ctx, alice)}`,
            "content-type": "application/json",
        },
        body: '{"display_name": "Alice"}',
    });
    assertEquals(updated.status, 200);
    await network.drain();
    assertEquals(await remoteNames(b.ctx), { alice: "Alice" });

    // Sending that delivery again is accepted, and changes nothing.
    const sent = [];
    for (const request of network.transport.sent) {
        if (new URL(request.url).host !== "b.test" || request.method !== "POST") continue;
        if ((await request.clone().json()).type === "User") sent.push(request);
    }
    assertEquals(sent.length, 1);
    assertEquals((await network.transport(sent[0])).status, 202);
    await network.drain();
    assertEquals(await remoteNames(b.ctx), { alice: "Alice" });
});

Deno.test("deliveries to a peer that is down wait for it, and all arrive once", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    const alice = await createLocalAccount(a, "alice");
    const bob = await a.federation.resolve(
        a,
        { host: "b.test", id: await createLocalAccount(b, "bob") },
        "User",
    );
    assertExists(bob);
    await b.federation.resolve(b, { host: "a.test", id: alice }, "User");

    network.transport.down.add("b.test");
    for (let n = 1; n <= 6; n++) {
        await updateProfile(a, alice, { displayName: `Alice ${n}` });
        await queueDeliveries(a, await userOf(a, alice), [bob]);
    }

    // Five failures park b.test, and one queued in the meantime waits too.
    await network.drain();
    assertEquals(sentTo(network, "b.test", inbox), 5);
    await updateProfile(a, alice, { displayName: "Alice 7" });
    await queueDeliveries(a, await userOf(a, alice), [bob]);
    await network.drain();
    assertEquals(sentTo(network, "b.test", inbox), 5);

    // A probe a minute later fails too.
    network.clock.advance(minute);
    await network.drain();
    assertEquals(sentTo(network, "b.test", inbox), 6);

    // Once it is back, the next probe gets through, and so does everything else.
    network.transport.down.delete("b.test");
    network.clock.advance(2 * minute);
    await network.drain();
    assertEquals(sentTo(network, "b.test", inbox), 13);

    const received = await b.db.selectFrom("jobs").select("id").where("queue", "=", "inbox")
        .execute();
    assertEquals(received.length, 7);
    assertEquals(await remoteNames(b), { alice: "Alice 7" });
});

Deno.test("an instance can't delete a local user, even claiming to be them", async () => {
    await using network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const evil = await addEvilInstance(network, "evil.test");
    const alice = await createLocalAccount(a, "alice");
    const deletion = (more: Record<string, string>) => ({
        type: "Delete",
        created_at: "2026-10-18T12:00:00Z",
        deleted_type: "User",
        deleted: `a.test:${alice}`,
        ...more,
    });

    for (const author of [`a.test:${alice}`, undefined]) {
        network.clock.advance(1000);
        const body = deletion(author ? { author } : {});
        assertEquals((await evil.send(`https://a.test${inbox}`, { body })).status, 202);
    }
    await network.drain();

    const errors = await a.db.selectFrom("jobs").select("last_error").where("queue", "=", "inbox")
        .orderBy("created_at").execute();
    assertStringIncludes(errors[0].last_error ?? "", "evil.test may not send this Delete");
    assertStringIncludes(errors[1].last_error ?? "", `evil.test may not delete a.test:${alice}`);
    assertExists(
        await a.db.selectFrom("accounts").select("id").where("id", "=", alice)
            .executeTakeFirst(),
    );
});

Deno.test("a blocked instance is neither asked, delivered to, nor heard", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    const b = network.instances["b.test"].ctx;
    const alice = await createLocalAccount(a.ctx, "alice");
    const bob = await a.ctx.federation.resolve(
        a.ctx,
        { host: "b.test", id: await createLocalAccount(b, "bob") },
        "User",
    );
    assertExists(bob);
    const carol = await createLocalAccount(b, "carol");

    await queueDeliveries(a.ctx, await userOf(a.ctx, alice), [bob]);
    await blockDomain(a.ctx, "b.test");
    const before = sentTo(network, "b.test");

    // What was queued is dropped, and nothing more is queued.
    await network.drain();
    await queueDeliveries(a.ctx, await userOf(a.ctx, alice), [bob]);
    const deliveries = await a.ctx.db.selectFrom("jobs").select("id")
        .where("queue", "=", deliverQueue).execute();
    assertEquals(deliveries, []);

    // Nor is it queried about its users.
    const lookup = await a.app.request("/api/v1/accounts/lookup?acct=dave@b.test", {
        headers: { authorization: `Bearer ${await tokenFor(a.ctx, alice)}` },
    });
    assertEquals(lookup.status, 404);
    assertEquals(sentTo(network, "b.test"), before);

    // What it sends is rejected, so it gives up.
    const payload: DeliverJob = { domain: "a.test", body: JSON.stringify(await userOf(b, carol)) };
    await enqueue(b, { queue: deliverQueue, payload, group: "a.test" });
    await network.drain();

    const sent = await b.db.selectFrom("jobs").select("last_error")
        .where("queue", "=", deliverQueue).executeTakeFirstOrThrow();
    assertStringIncludes(sent.last_error ?? "", "a.test refused the delivery (403)");
    assertEquals(await remoteNames(a.ctx), { bob: "" });
});
