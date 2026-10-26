import { assertEquals, assertRejects } from "@std/assert";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { type Address, findAccountByAddress, parseAddress } from "./addresses.ts";
import { createLocalAccount } from "./testing.ts";

/** a.test looking up accounts, and bob on b.test. */
const open = async () => {
    const network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const bob = await createLocalAccount(network.instances["b.test"].ctx, "bob");

    const find = async (acct: string, fetch = true) => {
        const address = parseAddress(a, acct);
        if (address === undefined) throw new Error(`${acct} isn't an address`);

        const row = await findAccountByAddress(a, address, { fetch });
        return row && { id: row.id, acct: `${row.username}@${row.domain ?? "a.test"}` };
    };

    /** How many requests a.test has sent to `host`. */
    const asked = (host: string) =>
        network.transport.sent.filter((request) => new URL(request.url).host === host).length;

    return { network, a, bob, find, asked };
};

Deno.test("an address is a username, and a domain unless it is this instance's", async () => {
    await using network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const parse = (acct: string) => parseAddress(a, acct);

    const local: Address = { username: "alice", domain: null };
    for (const acct of ["alice", "@alice", "alice@a.test", "alice@A.Test"]) {
        assertEquals(parse(acct), local, acct);
    }
    assertEquals(parse("@bob@B.Test"), { username: "bob", domain: "b.test" });

    for (const acct of ["", "@", "bob@", "bob@b.test@c.test", "bob@localhost"]) {
        assertEquals(parse(acct), undefined, acct);
    }
});

Deno.test("a remote account is found by its address, and then by its id there", async () => {
    const { network, find, asked } = await open();
    await using _ = network;

    const bob = await find("bob@b.test");
    assertEquals(bob?.acct, "bob@b.test");
    assertEquals(await find("BOB@b.test"), bob);

    // WebFinger, the key, and the User; then nothing more until the stored copy is a day old.
    assertEquals(asked("b.test"), 3);

    network.clock.advance(24 * 60 * 60_000);
    assertEquals(await find("bob@b.test"), bob);
    assertEquals(asked("b.test"), 4);

    assertEquals(await find("nobody@b.test"), undefined);
});

Deno.test("without fetching, only accounts Verso has are found", async () => {
    const { network, find, asked } = await open();
    await using _ = network;

    assertEquals(await find("bob@b.test", false), undefined);
    assertEquals(asked("b.test"), 0);

    const bob = await find("bob@b.test");
    network.clock.advance(24 * 60 * 60_000);
    assertEquals(await find("bob@b.test", false), bob);
    assertEquals(asked("b.test"), 3);
});

Deno.test("when an instance fails, the account Verso has is used", async () => {
    const { network, find } = await open();
    await using _ = network;
    const bob = await find("bob@b.test");

    network.transport.down.add("b.test");
    network.clock.advance(24 * 60 * 60_000);
    assertEquals(await find("bob@b.test"), bob);
    assertEquals(await find("carol@b.test"), undefined);
});

Deno.test("an instance can't answer for one user with another", async () => {
    const { network, find } = await open();
    await using _ = network;
    const evil = await addEvilInstance(network, "evil.test");

    evil.serve("/.well-known/webfinger", {
        links: [{
            rel: "self",
            type: "application/vnd.versia+json",
            href: "https://evil.test/.versia/v0.6/entities/User/mallory",
        }],
    });
    evil.serve("/.versia/v0.6/entities/User/mallory", {
        type: "User",
        id: "mallory",
        created_at: "2026-10-18T12:00:00Z",
        username: "mallory",
        fields: [],
        manually_approves_followers: false,
        indexable: true,
    });

    assertEquals(await find("alice@evil.test"), undefined);
    assertEquals((await find("mallory@evil.test"))?.acct, "mallory@evil.test");
});

Deno.test("an instance answering badly is the same as the user not being there", async () => {
    const { network, find } = await open();
    await using _ = network;
    const evil = await addEvilInstance(network, "evil.test");

    evil.serve("/.well-known/webfinger", "not json");
    assertEquals(await find("alice@evil.test"), undefined);

    evil.serve("/.well-known/webfinger", "x".repeat(2 * 1024 * 1024));
    assertEquals(await find("alice@evil.test"), undefined);
});

Deno.test("Verso's own failures aren't taken for an instance's", async () => {
    const { network, a } = await open();
    await using _ = network;
    const broken = {
        ...a,
        federation: { ...a.federation, resolve: () => Promise.reject(new Error("Broken")) },
    };

    await assertRejects(
        () => findAccountByAddress(broken, { username: "bob", domain: "b.test" }, { fetch: true }),
        Error,
        "Broken",
    );
});
