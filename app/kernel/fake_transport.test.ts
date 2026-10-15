import { assertEquals, assertRejects } from "@std/assert";
import { fakeTransport } from "./fake_transport.ts";

const echo = async (request: Request) =>
    new Response(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);

Deno.test("requests reach the server for their host, and are recorded", async () => {
    const transport = fakeTransport({ "b.test": echo });

    const response = await transport(
        new Request("https://b.test/inbox", { method: "POST", body: "hello" }),
    );

    assertEquals(await response.text(), "POST /inbox hello");
    assertEquals(transport.sent.length, 1);
    assertEquals(await transport.sent[0].text(), "hello");
});

Deno.test("unknown and down hosts can't be reached, like with fetch", async () => {
    const transport = fakeTransport({ "b.test": echo });

    await assertRejects(() => transport(new Request("https://c.test/")), TypeError);

    transport.down.add("b.test");
    await assertRejects(() => transport(new Request("https://b.test/")), TypeError);

    transport.down.delete("b.test");
    assertEquals((await transport(new Request("https://b.test/"))).status, 200);

    assertEquals(transport.sent.map((request) => request.url), [
        "https://c.test/",
        "https://b.test/",
        "https://b.test/",
    ]);
});

Deno.test("hosts include the port, so servers on one name but other ports are separate", async () => {
    const transport = fakeTransport({ "b.test:8443": echo });

    await assertRejects(() => transport(new Request("https://b.test/")), TypeError);
    assertEquals((await transport(new Request("https://b.test:8443/"))).status, 200);
});
