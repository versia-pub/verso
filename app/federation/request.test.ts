import denoConfig from "../../deno.json" with { type: "json" };
import { assertEquals, assertRejects } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { createNetwork } from "../testing/network.ts";
import { BadReply, fetchSigned, requestTarget, Unreachable, verifyReply } from "./request.ts";

const userUrl = (domain: string, id: string) =>
    new URL(`https://${domain}/.versia/v0.7/entities/User/${id}`);

Deno.test("a signed GET reaches another instance, whose signed reply is given", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    await createLocalAccount(network.instances["b.test"].ctx, "bob");

    const reply = await fetchSigned(a.ctx, userUrl("b.test", "bob"));

    assertEquals(reply.status, 200);
    assertEquals(JSON.parse(new TextDecoder().decode(reply.body)).username, "bob");

    const [request] = network.transport.sent.filter((sent) => sent.url.includes("/User/"));
    assertEquals(
        request.headers.get("user-agent"),
        `Verso/${denoConfig.version} (+https://a.test)`,
    );
    assertEquals(request.headers.get("versia-signed-by"), "a.test");
});

Deno.test("a reply that isn't an error is refused unless the instance asked signed it", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    await createLocalAccount(network.instances["b.test"].ctx, "bob");

    // Replays b.test's signed reply to the same request, as if it were b.test.
    const genuine = await fetchSigned(a.ctx, userUrl("b.test", "bob"));
    network.transport.servers.set(
        "evil.test",
        () => new Response(genuine.body, { headers: genuine.headers }),
    );
    network.transport.servers.set("unsigned.test", () => Response.json({ type: "User" }));

    for (const domain of ["evil.test", "unsigned.test"]) {
        await assertRejects(
            () => fetchSigned(a.ctx, userUrl(domain, "bob")),
            BadReply,
            `isn't signed by ${domain}`,
        );
    }
});

Deno.test("a request relayed to another instance is turned away, as it names the wrong host", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    await createLocalAccount(network.instances["b.test"].ctx, "bob");
    network.transport.servers.set("evil.test", (request) => {
        const url = new URL(request.url);
        url.host = "b.test";
        return network.instances["b.test"].app.fetch(new Request(url, request));
    });

    const reply = await fetchSigned(a.ctx, userUrl("evil.test", "bob"));

    assertEquals(reply.status, 401);
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

    // A bug in Verso, before anything is sent, is not the remote instance's fault.
    const broken = {
        ...a,
        federation: { ...a.federation, instanceKey: () => Promise.reject(new TypeError("A bug")) },
    };
    await assertRejects(() => fetchSigned(broken, userUrl("down.test", "bob")), TypeError, "A bug");
});

Deno.test("a request target is the path and query as sent, without the fragment", () => {
    const target = (url: string) => requestTarget(new URL(url));

    assertEquals(target("https://a.test/b/c"), "/b/c");
    assertEquals(target("https://a.test/b?x=1&y=2"), "/b?x=1&y=2");
    assertEquals(target("https://a.test/b?"), "/b?");
    assertEquals(target("https://a.test/b?x=1#top"), "/b?x=1");
    assertEquals(target("https://a.test/b#top"), "/b");
    assertEquals(target("https://a.test/a%2Fb/%7Euser?q=%20"), "/a%2Fb/%7Euser?q=%20");
    assertEquals(target("https://a.test:8443/"), "/");
});

Deno.test("a reply is only verified for the request it answers", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    await createLocalAccount(network.instances["b.test"].ctx, "bob");
    const url = userUrl("b.test", "bob");
    const reply = await fetchSigned(a, url);

    assertEquals(await verifyReply(a, "GET", url, reply), true);
    assertEquals(await verifyReply(a, "POST", url, reply), false);
    assertEquals(await verifyReply(a, "GET", userUrl("b.test", "other"), reply), false);
    assertEquals(await verifyReply(a, "GET", new URL(`${url}?x=1`), reply), false);
    assertEquals(await verifyReply(a, "GET", new URL(`${url}?`), reply), false);
    assertEquals(await verifyReply(a, "GET", userUrl("c.test", "bob"), reply), false);
});

Deno.test("a reply to a request with a query is signed over the query", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    await createLocalAccount(network.instances["b.test"].ctx, "bob");

    const reply = await fetchSigned(a, new URL(`${userUrl("b.test", "bob")}?x=1`));

    assertEquals(reply.status, 200);
    assertEquals(await verifyReply(a, "GET", userUrl("b.test", "bob"), reply), false);
});
