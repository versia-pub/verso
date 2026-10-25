import { assertEquals, assertRejects } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { createNetwork } from "../testing/network.ts";
import { BadReply, fetchSigned, Unreachable } from "./request.ts";

const userUrl = (domain: string, id: string) =>
    new URL(`https://${domain}/.versia/v0.6/entities/User/${id}`);

Deno.test("a signed GET reaches another instance, whose signed reply is given", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    await createLocalAccount(network.instances["b.test"].ctx, "bob");

    const reply = await fetchSigned(a.ctx, userUrl("b.test", "bob"));

    assertEquals(reply.status, 200);
    assertEquals(JSON.parse(new TextDecoder().decode(reply.body)).username, "bob");

    const [request] = network.transport.sent.filter((sent) => sent.url.includes("/User/"));
    assertEquals(request.headers.get("user-agent"), "Verso/0.0.0 (+https://a.test)");
    assertEquals(request.headers.get("versia-signed-by"), "a.test");
});

Deno.test("a reply that isn't an error is refused unless the instance asked signed it", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    await createLocalAccount(network.instances["b.test"].ctx, "bob");

    // Answers with b.test's signed reply, as if it were b.test.
    network.transport.servers.set("evil.test", (request) => {
        const url = new URL(request.url);
        url.host = "b.test";
        return network.instances["b.test"].app.fetch(new Request(url, request));
    });
    network.transport.servers.set("unsigned.test", () => Response.json({ type: "User" }));

    for (const domain of ["evil.test", "unsigned.test"]) {
        await assertRejects(
            () => fetchSigned(a.ctx, userUrl(domain, "bob")),
            BadReply,
            `isn't signed by ${domain}`,
        );
    }
});

Deno.test("an error reply is given as it is, signed or not", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];

    const reply = await fetchSigned(a.ctx, userUrl("b.test", "nobody"));

    assertEquals(reply.status, 404);
});

Deno.test("a reply larger than 256 KiB is refused", async () => {
    await using network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"];
    network.transport.servers.set("big.test", () => new Response(new Uint8Array(256 * 1024 + 1)));
    network.transport.servers.set("fits.test", () => new Response(new Uint8Array(256 * 1024)));

    await assertRejects(
        () => fetchSigned(a.ctx, userUrl("big.test", "bob")),
        BadReply,
        "larger than",
    );
    await assertRejects(
        () => fetchSigned(a.ctx, userUrl("fits.test", "bob")),
        BadReply,
        "isn't signed",
    );
});

Deno.test("only a request that fails to get there counts as unreachable", async () => {
    await using network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;

    await assertRejects(
        () => fetchSigned(a, userUrl("down.test", "bob")),
        Unreachable,
        "down.test couldn't be reached",
    );

    // A bug in Verso, before anything is sent, is not the instance's doing.
    const broken = {
        ...a,
        federation: { ...a.federation, instanceKey: () => Promise.reject(new TypeError("A bug")) },
    };
    await assertRejects(() => fetchSigned(broken, userUrl("down.test", "bob")), TypeError, "A bug");
});
