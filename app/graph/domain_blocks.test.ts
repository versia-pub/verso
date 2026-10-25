import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { block, blockedByAccount, type Excluded, isExcluded } from "./blocks.ts";
import { domainBlockedAmong, domainBlockPage } from "./domain_block_queries.ts";
import { blockDomainFor, unblockDomainFor } from "./domain_blocks.ts";
import { hiddenAmong, hiddenFrom } from "./hidden.ts";
import { mute } from "./mutes.ts";

/** alice and bob here, and an account on each of a few domains, named for where it is. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    const remote = {
        exact: "b.example",
        sub: "a.b.example",
        lookalike: "xb.example",
        other: "c.example",
    };
    for (const [id, domain] of Object.entries(remote)) {
        await createInstance(test.ctx, domain);
        await createRemoteAccount(test.ctx, id, domain);
    }
    const everyone = ["alice", "bob", ...Object.keys(remote)];

    /** The accounts that are among `excluded`, in order. */
    const ids = async (excluded: Excluded) =>
        (await test.ctx.db.selectFrom("accounts").select("id")
            .where(isExcluded(excluded, "accounts.id")).execute())
            .map((row) => row.id).toSorted();

    return { ...test, everyone, ids };
};

Deno.test("blocking a domain blocks its accounts and its subdomains' only, for the blocker", async () => {
    await using test = await open();
    await blockDomainFor(test.ctx, "alice", "b.example");
    await blockDomainFor(test.ctx, "alice", "b.example");
    await blockDomainFor(test.ctx, "bob", "c.example");

    assertEquals([...await domainBlockedAmong(test.ctx, "alice", test.everyone)].toSorted(), [
        "exact",
        "sub",
    ]);
    assertEquals([...await domainBlockedAmong(test.ctx, "bob", test.everyone)], ["other"]);
    assertEquals(await domainBlockedAmong(test.ctx, "alice", []), new Set());
});

Deno.test("unblocking a domain says whether it was blocked", async () => {
    await using test = await open();
    await blockDomainFor(test.ctx, "alice", "b.example");
    await blockDomainFor(test.ctx, "alice", "c.example");
    await blockDomainFor(test.ctx, "bob", "b.example");

    assertEquals(await unblockDomainFor(test.ctx, "alice", "b.example"), true);
    assertEquals(await unblockDomainFor(test.ctx, "alice", "b.example"), false);
    assertEquals(await domainBlockedAmong(test.ctx, "alice", test.everyone), new Set(["other"]));
    assertEquals(await domainBlockedAmong(test.ctx, "bob", ["exact"]), new Set(["exact"]));
});

Deno.test("the blocked domains are listed, the latest blocked first, a page at a time", async () => {
    await using test = await open();
    for (const domain of ["b.example", "c.example", "d.example"]) {
        test.clock.advance(1);
        await blockDomainFor(test.ctx, "alice", domain);
    }
    await blockDomainFor(test.ctx, "bob", "e.example");
    const domains = async (limit: number) =>
        (await domainBlockPage(test.ctx, "alice", { limit })).map((each) => each.domain);

    assertEquals(await domains(2), ["d.example", "c.example"]);
    assertEquals(await domains(40), ["d.example", "c.example", "b.example"]);
});

Deno.test("what doesn't reach an account includes the accounts on the domains it blocks", async () => {
    await using test = await open();
    await blockDomainFor(test.ctx, "alice", "b.example");
    await block(test.ctx, "alice", "bob");
    await mute(test.ctx, "alice", "other", { notifications: true, duration: 0 });
    await blockDomainFor(test.ctx, "bob", "xb.example");

    assertEquals(await test.ids(blockedByAccount(test.ctx, "alice")), ["bob", "exact", "sub"]);
    assertEquals(await test.ids(hiddenFrom(test.ctx, "alice")), [
        "bob",
        "exact",
        "other",
        "sub",
    ]);
    assertEquals([...await hiddenAmong(test.ctx, "alice", test.everyone)].toSorted(), [
        "bob",
        "exact",
        "other",
        "sub",
    ]);
});
