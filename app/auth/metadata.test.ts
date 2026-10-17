import { assertEquals } from "@std/assert";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../kernel/testing.ts";
import { authRoutes } from "./routes.ts";

Deno.test("the OAuth metadata names this server's endpoints", async () => {
    await using test = await createTestContext();
    const http = createTestApp(test.ctx, authRoutes, { checkResponses: true });

    const response = await http.request("/.well-known/oauth-authorization-server");
    const metadata = await response.json();

    assertEquals(response.status, 200);
    assertEquals(metadata.issuer, "https://social.example");
    assertEquals(metadata.code_challenge_methods_supported, ["S256"]);
    assertEquals(metadata.scopes_supported.includes("read:statuses"), true);

    const endpoints = [
        ["GET", metadata.authorization_endpoint],
        ["POST", metadata.token_endpoint],
        ["POST", metadata.revocation_endpoint],
        ["POST", metadata.app_registration_endpoint],
    ];
    for (const [method, url] of endpoints) {
        const { pathname } = new URL(url);
        const served = authRoutes.some((route) =>
            route.method === method && route.path === pathname
        );
        assertEquals(served, true, `${method} ${pathname}`);
    }
});
