import { assertEquals } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import { blockDomain, domainBlocks, unblockDomain } from "./domain_blocks.ts";
import { blockedDomainNames, listBlockedDomains } from "./domain_block_queries.ts";

Deno.test("a blocked domain is blocked with its subdomains, but not its parents", async () => {
    await using test = await createTestContext();
    const isBlocked = domainBlocks(["config.example"], blockedDomainNames);
    await blockDomain(test.ctx, "evil.example");

    const blocked = async (domain: string) => await isBlocked(test.ctx, domain);
    for (
        const domain of ["evil.example", "a.b.evil.example", "config.example", "a.config.example"]
    ) {
        assertEquals(await blocked(domain), true, domain);
    }
    for (const domain of ["example", "notevil.example", "evil.example.org", "good.example"]) {
        assertEquals(await blocked(domain), false, domain);
    }
});

Deno.test("a domain is blocked once, with its first reason, and unblocked once", async () => {
    await using test = await createTestContext();
    const isBlocked = domainBlocks([], blockedDomainNames);

    const domains = async () =>
        (await listBlockedDomains(test.ctx)).map((block) => [block.domain, block.reason]);

    assertEquals(await blockDomain(test.ctx, "evil.example", "Spam"), true);
    assertEquals(await blockDomain(test.ctx, "evil.example", "Harassment"), false);
    await blockDomain(test.ctx, "bad.example");
    assertEquals(await domains(), [["bad.example", ""], ["evil.example", "Spam"]]);

    assertEquals(await unblockDomain(test.ctx, "evil.example"), true);
    assertEquals(await unblockDomain(test.ctx, "evil.example"), false);
    assertEquals(await isBlocked(test.ctx, "evil.example"), false);
    assertEquals(await domains(), [["bad.example", ""]]);
});

Deno.test("blocks made here apply at once, and ones made elsewhere within a minute", async () => {
    await using test = await createTestContext();
    const isBlocked = (domain: string) => test.ctx.federation.isBlocked(test.ctx, domain);
    assertEquals(await isBlocked("evil.example"), false);

    await blockDomain(test.ctx, "evil.example");
    assertEquals(await isBlocked("evil.example"), true);

    // As the CLI blocks one, from its own process.
    await test.ctx.db.insertInto("domain_blocks")
        .values({ domain: "bad.example", reason: "", created_at: test.clock.now() })
        .execute();
    test.clock.advance(60_000 - 1);
    assertEquals(await isBlocked("bad.example"), false);
    test.clock.advance(1);
    assertEquals(await isBlocked("bad.example"), true);

    await unblockDomain(test.ctx, "evil.example");
    assertEquals(await isBlocked("evil.example"), false);
});
