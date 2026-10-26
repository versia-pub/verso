import { assertEquals, assertRejects } from "@std/assert";
import {
    federationTransport,
    type FederationTransportOptions,
    timedTransport,
    type Transport,
} from "./transport.ts";

/** A transport over a fake network, where `dns` says what each name resolves to. */
const open = (dns: Record<string, string[]>, options: FederationTransportOptions = {}) => {
    const sent: { url: string; redirect: RequestRedirect | undefined }[] = [];
    const transport = federationTransport({
        ...options,
        resolve: (hostname) => Promise.resolve(dns[hostname] ?? []),
        fetch: (request, init) => {
            sent.push({ url: request.url, redirect: init.redirect });
            return Promise.resolve(new Response(null, { status: 302, headers: { location: "/" } }));
        },
    });

    return { transport, sent };
};

const internal = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "64:ff9b:1::a00:1",
    "100::1",
    "2001:0:4136:e378::1",
    "2001:db8::1",
    "2002:a00:1::1",
];

Deno.test("another instance is reached at its public address, and its redirects aren't followed", async () => {
    const { transport, sent } = open({ "b.example": ["93.184.216.34", "2606:2800:220:1::1"] });

    const response = await transport(new Request("https://b.example/.versia/v0.6/instance"));

    assertEquals(response.status, 302);
    assertEquals(sent, [{ url: "https://b.example/.versia/v0.6/instance", redirect: "manual" }]);
});

Deno.test("a name that resolves to an internal address, or not at all, isn't reached", async () => {
    const dns: Record<string, string[]> = {};
    for (const address of internal) {
        dns[`at-${address.replaceAll(/[.:]/g, "-")}.example`] = [address];
    }
    dns["mixed.example"] = ["93.184.216.34", "10.0.0.1"];
    const { transport, sent } = open(dns);

    for (const hostname of [...Object.keys(dns), "missing.example"]) {
        await assertRejects(
            () => transport(new Request(`https://${hostname}/`)),
            TypeError,
            "isn't a public address",
        );
    }
    assertEquals(sent, []);
});

Deno.test("an address given directly is checked without resolving it", async () => {
    const { transport, sent } = open({});

    await transport(new Request("https://93.184.216.34/"));
    await transport(new Request("https://[2606:2800:220:1::1]/"));
    for (const url of ["https://127.0.0.1:6379/", "https://[::1]/", "https://[fd00::1]:8443/"]) {
        await assertRejects(() => transport(new Request(url)), TypeError, "isn't a public address");
    }
    assertEquals(sent.map((request) => request.url), [
        "https://93.184.216.34/",
        "https://[2606:2800:220:1::1]/",
    ]);
});

Deno.test("internal addresses can be allowed, for a local network", async () => {
    const { transport, sent } = open({ "b.lan": ["192.168.1.2"] }, { allowInternal: true });

    await transport(new Request("https://b.lan/"));
    await transport(new Request("https://127.0.0.1:8443/"));

    assertEquals(sent.map((request) => request.redirect), ["manual", "manual"]);
});

Deno.test("a timed transport gives up on a server that takes too long, but not on others", async () => {
    // Responds at once, or never, but for when the request is given up on.
    const transport: Transport = (request) =>
        request.url.includes("slow")
            ? new Promise((_, reject) => {
                request.signal.addEventListener("abort", () => reject(request.signal.reason));
            })
            : Promise.resolve(new Response("Hi"));
    const timed = timedTransport(transport, 20);

    await assertRejects(() => timed(new Request("https://slow.example/")));
    assertEquals(await (await timed(new Request("https://fast.example/"))).text(), "Hi");

    // Its own signal still counts, at once.
    const stopping = new AbortController();
    const asked = timedTransport(transport, 60 * 60_000)(
        new Request("https://slow.example/", { signal: stopping.signal }),
    ).then(() => "answered", () => "stopped");
    stopping.abort();
    const soon = new Promise((resolve) => setTimeout(() => resolve("waiting"), 1000));
    assertEquals(await Promise.race([asked, soon]), "stopped");
});
