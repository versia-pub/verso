import { assertEquals, assertRejects } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { BadReply } from "./request.ts";
import { ResolveFailed } from "./resolver.ts";
import { webfinger } from "./webfinger.ts";

const versia = "application/vnd.versia+json";

const open = async () => {
    const network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const evil = await addEvilInstance(network, "evil.test");

    /** Has evil.test answer WebFinger with these links. */
    const links = (...links: unknown[]) =>
        evil.serve("/.well-known/webfinger", { subject: "acct:x@evil.test", links });

    /** How many WebFinger lookups `host` was sent. */
    const asked = (host: string) =>
        network.transport.sent.filter((request) => new URL(request.url).host === host).length;

    return { network, a, evil, links, asked };
};

Deno.test("a user on another Verso is found by its address", async () => {
    const { network, a } = await open();
    await using _ = network;
    const bob = await createLocalAccount(network.instances["b.test"].ctx, "bob");

    assertEquals(await webfinger(a, "bob", "b.test"), { host: "b.test", id: bob });
    assertEquals(await webfinger(a, "BOB", "B.Test"), { host: "b.test", id: bob });
    assertEquals(await webfinger(a, "nobody", "b.test"), undefined);
});

Deno.test("only a Versia User link on the same host is followed", async () => {
    const { network, a, links } = await open();
    await using _ = network;
    const lookup = () => webfinger(a, "x", "evil.test");
    const self = (href: string, type = versia) => ({ rel: "self", type, href });

    links(self("https://evil.test/.versia/v0.6/entities/User/x1"));
    assertEquals(await lookup(), { host: "evil.test", id: "x1" });

    links(
        { rel: "http://webfinger.net/rel/profile-page", href: "https://evil.test/@x" },
        self("https://evil.test/.versia/v0.6/entities/User/x2", `${versia}; charset=utf-8`),
    );
    assertEquals(await lookup(), { host: "evil.test", id: "x2" });

    for (
        const link of [
            self("https://b.test/.versia/v0.6/entities/User/x"),
            self("http://evil.test/.versia/v0.6/entities/User/x"),
            self("https://evil.test/.versia/v0.6/entities/Note/x"),
            self("https://evil.test/.versia/v0.6/entities/User/x?y=1"),
            self("https://evil.test/.versia/v0.6/entities/User/x", "application/activity+json"),
            {
                rel: "alternate",
                type: versia,
                href: "https://evil.test/.versia/v0.6/entities/User/x",
            },
        ]
    ) {
        links(link);
        assertEquals(await lookup(), undefined, JSON.stringify(link));
    }
});

Deno.test("an instance that isn't a domain, or is blocked, isn't asked", async () => {
    const { network, a, asked } = await open();
    await using _ = network;
    await blockDomain(a, "b.test");

    for (const domain of ["localhost", "192.0.2.1", "b.test:8443", "a.b.test"]) {
        assertEquals(await webfinger(a, "bob", domain), undefined, domain);
    }
    assertEquals(asked("b.test") + asked("a.b.test") + asked("localhost"), 0);
});

Deno.test("an answer that isn't WebFinger, or can't be had, throws", async () => {
    const { network, a, evil } = await open();
    await using _ = network;

    evil.serve("/.well-known/webfinger", "not json");
    await assertRejects(() => webfinger(a, "x", "evil.test"), ResolveFailed);

    evil.serve("/.well-known/webfinger", { links: "no" });
    await assertRejects(() => webfinger(a, "x", "evil.test"), ResolveFailed);

    evil.serve("/.well-known/webfinger", "x".repeat(2 * 1024 * 1024));
    await assertRejects(() => webfinger(a, "x", "evil.test"), BadReply);

    network.transport.down.add("evil.test");
    await assertRejects(() => webfinger(a, "x", "evil.test"));
});
