import { assertEquals } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import { blockDomain, domainBlocks, listBlockedDomains, unblockDomain } from "./domain_blocks.ts";

Deno.test("a blocked domain is blocked with its subdomains, but not its parents", async () => {
    await using test = await createTestContext();
    const isBlocked = domainBlocks(["config.example"]);
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
    const isBlocked = domainBlocks([]);

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
