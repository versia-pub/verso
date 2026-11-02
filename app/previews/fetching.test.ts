import { assertEquals } from "@std/assert";
import { fakeTransport } from "../kernel/fake_transport.ts";
import { federationTransport } from "../kernel/transport.ts";
import { createTestContext } from "../testing/context.ts";
import { decodePage, fetchLimited } from "./fetching.ts";

const html = { accept: "text/html", approves: (type: string) => type === "text/html" };

const page = (body: BodyInit, type = "text/html; charset=utf-8", status = 200) => () =>
    new Response(body, { status, headers: { "content-type": type } });

const fetchFrom = async (
    servers: Parameters<typeof fakeTransport>[0],
    url: string,
    limit = 1000,
) => {
    await using test = await createTestContext({ transport: fakeTransport(servers) });
    const fetched = await fetchLimited(test.ctx, new URL(url), { ...html, limit });

    return { fetched, sent: test.transport.sent };
};

Deno.test("a page is fetched as a bot, asking for HTML", async () => {
    const { fetched, sent } = await fetchFrom(
        { "a.example": page("<p>Hi</p>") },
        "https://a.example/x",
    );

    assertEquals(new TextDecoder().decode(fetched?.body), "<p>Hi</p>");
    assertEquals(fetched?.url.href, "https://a.example/x");
    assertEquals(sent[0].headers.get("accept"), "text/html");
    assertEquals(sent[0].headers.get("user-agent")?.endsWith(" Bot"), true);
});

Deno.test("redirects are followed, and the card is for where they end", async () => {
    const { fetched, sent } = await fetchFrom({
        "a.example": () =>
            new Response(null, { status: 301, headers: { location: "https://b.example/y" } }),
        "b.example": page("ok"),
    }, "https://a.example/x");

    assertEquals(fetched?.url.href, "https://b.example/y");
    assertEquals(sent.map((request) => request.url), [
        "https://a.example/x",
        "https://b.example/y",
    ]);
});

Deno.test("redirects that never end, or leave the web, give up", async () => {
    const loop = () => new Response(null, { status: 302, headers: { location: "/again" } });
    assertEquals((await fetchFrom({ "a.example": loop }, "https://a.example/")).sent.length, 6);
    assertEquals((await fetchFrom({ "a.example": loop }, "https://a.example/")).fetched, undefined);

    const file = () =>
        new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } });
    assertEquals((await fetchFrom({ "a.example": file }, "https://a.example/")).fetched, undefined);
});

Deno.test("every hop of a redirect is checked, so one to an internal address is refused", async () => {
    await using test = await createTestContext();
    const reached: string[] = [];
    const transport = federationTransport({
        resolve: (hostname) =>
            Promise.resolve(hostname === "evil.example" ? ["10.0.0.5"] : ["93.184.216.34"]),
        fetch: (request) => {
            reached.push(request.url);
            return Promise.resolve(
                request.url.startsWith("https://a.example")
                    ? new Response(null, {
                        status: 302,
                        headers: { location: "https://evil.example/secret" },
                    })
                    : new Response("secret", { headers: { "content-type": "text/html" } }),
            );
        },
    });

    const fetched = await fetchLimited({ ...test.ctx, transport }, new URL("https://a.example/"), {
        ...html,
        limit: 1000,
    });

    assertEquals(fetched, undefined);
    assertEquals(reached, ["https://a.example/"]);
});

Deno.test("only a 200 of an approved type is read", async () => {
    assertEquals(
        (await fetchFrom({ "a.example": page("x", "text/html", 404) }, "https://a.example/"))
            .fetched,
        undefined,
    );
    assertEquals(
        (await fetchFrom({ "a.example": page("x", "application/pdf") }, "https://a.example/"))
            .fetched,
        undefined,
    );
    assertEquals(
        (await fetchFrom({ "a.example": () => new Response("x") }, "https://a.example/")).fetched,
        undefined,
    );
});

Deno.test("a body is cut at the limit", async () => {
    const { fetched } = await fetchFrom(
        { "a.example": page("a".repeat(5000)) },
        "https://a.example/",
        1000,
    );

    assertEquals(fetched?.body.length, 1000);
    assertEquals(fetched?.truncated, true);

    const exact = await fetchFrom(
        { "a.example": page("a".repeat(1000)) },
        "https://a.example/",
        1000,
    );
    assertEquals(exact.fetched?.truncated, false);
});

Deno.test("a server that can't be reached has no page", async () => {
    assertEquals((await fetchFrom({}, "https://gone.example/")).fetched, undefined);
});

Deno.test("a page is decoded in the charset the header or the page names", () => {
    const bytes = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
    const of = (type: string, body: Uint8Array<ArrayBuffer>) =>
        decodePage({
            url: new URL("https://a.example/"),
            headers: new Headers({ "content-type": type }),
            body,
            truncated: false,
        });

    assertEquals(of("text/html; charset=iso-8859-1", bytes), "café");
    assertEquals(
        of(
            "text/html",
            Uint8Array.from([...new TextEncoder().encode('<meta charset="latin1">'), ...bytes]),
        ),
        '<meta charset="latin1">café',
    );
    assertEquals(
        of(
            "text/html; charset=iso-8859-1",
            Uint8Array.from([...new TextEncoder().encode('<meta charset="utf-8">'), ...bytes]),
        ),
        '<meta charset="utf-8">café',
    );
    assertEquals(of("text/html; charset=nonsense", new TextEncoder().encode("café")), "café");
    assertEquals(of("text/html", new TextEncoder().encode("café")), "café");
});
