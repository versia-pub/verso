/**
 * Reports end to end, between complete instances, through the client API: a report of a remote
 * account reaching its instance, and that of the account it replied to.
 * @module
 */
import { assertEquals, assertExists } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { type Client, clientOf, followAddress } from "../testing/clients.ts";
import { createNetwork } from "../testing/network.ts";
import { reportsForAdmin } from "./reports.ts";

Deno.test("a forwarded report reaches the account's instance, and that of whom it replied to", async () => {
    await using network = await createNetwork(["a.test", "b.test", "c.test"]);
    const users: Record<string, Client> = {};
    for (const [id, domain] of [["alice", "a.test"], ["bob", "b.test"], ["carol", "c.test"]]) {
        const instance = network.instances[domain];
        users[id] = await clientOf(instance, await createLocalAccount(instance.ctx, id));
    }
    const bob = await followAddress(users.alice, "bob@b.test");
    await followAddress(users.bob, "carol@c.test");
    await network.drain();

    // bob replies rudely to carol, and alice sees it.
    const posted = await users.carol("POST", "/api/v1/statuses", { status: "Hello" });
    await network.drain();
    const [hello] = (await users.bob("GET", "/api/v1/timelines/home")).body;
    const reply = await users.bob("POST", "/api/v1/statuses", {
        status: "@carol@c.test Go away",
        in_reply_to_id: hello.id,
    });
    assertEquals([posted.status, reply.status], [200, 200]);
    await network.drain();
    const [seen] = (await users.alice("GET", `/api/v1/accounts/${bob}/statuses`)).body;
    assertEquals(seen.uri, reply.body.uri);

    const filed = await users.alice("POST", "/api/v1/reports", {
        account_id: bob,
        status_ids: [seen.id],
        comment: "Rude",
        category: "spam",
        forward: true,
        forward_to_domains: ["b.test", "c.test"],
    });
    assertEquals([filed.status, filed.body.forwarded], [200, true]);
    await network.drain();

    const [onB] = await reportsForAdmin(network.instances["b.test"].ctx, false);
    const [onC] = await reportsForAdmin(network.instances["c.test"].ctx, false);
    assertExists(onB);
    assertExists(onC);
    assertEquals(
        [onB.reporter, onB.instance, onB.target, onB.category, onB.comment, onB.status_ids],
        [null, "a.test", "bob", "spam", "Rude", [reply.body.id]],
    );
    assertEquals(
        [onC.reporter, onC.instance, onC.target, onC.comment, onC.status_ids.length],
        [null, "a.test", "bob@b.test", "Rude", 1],
    );
});
