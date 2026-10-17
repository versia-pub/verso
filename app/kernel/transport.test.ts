import { assertEquals } from "@std/assert";
import { federationTransport } from "./transport.ts";

Deno.test("another instance's redirects aren't followed", async () => {
    const sent: { url: string; redirect: RequestRedirect | undefined }[] = [];
    const transport = federationTransport({
        fetch: (request, init) => {
            sent.push({ url: request.url, redirect: init.redirect });
            return Promise.resolve(new Response(null, { status: 302, headers: { location: "/" } }));
        },
    });

    const response = await transport(new Request("https://b.example/.versia/v0.6/instance"));

    assertEquals(response.status, 302);
    assertEquals(sent, [{ url: "https://b.example/.versia/v0.6/instance", redirect: "manual" }]);
});
