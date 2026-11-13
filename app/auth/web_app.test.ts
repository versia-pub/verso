import { assertEquals } from "@std/assert";
import { scopes } from "../kernel/scopes.ts";
import { urlBuilder } from "../kernel/urls.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { findAppByClientId, updateApp } from "./app_queries.ts";
import { authRoutes } from "./routes.ts";
import { hashToken, randomToken } from "./secrets.ts";
import { flowCookie, registerTestApp, startFlow, stubProvider } from "./testing.ts";
import { ensureWebApp, webClientId } from "./web_app.ts";

const open = async () => {
    const provider = stubProvider();
    const test = await createTestContext({
        identityProviders: { [provider.issuer.url]: provider },
    });
    const http = createTestApp(test.ctx, authRoutes, { checkResponses: true });

    const webApp = () => findAppByClientId(test.ctx, webClientId);

    /** Logs alice in to an app with PKCE, returning where the callback sends the browser. */
    const logIn = async (clientId: string, redirectUri: string) => {
        const verifier = randomToken();
        const start = await startFlow(http, {
            client_id: clientId,
            redirect_uri: redirectUri,
            scope: "read write",
            state: "xyz",
            code_challenge: await hashToken(verifier),
            code_challenge_method: "S256",
        });
        const cookie = flowCookie(start);
        const back = await http.request("/oauth/callback?code=good&state=s", {
            headers: { cookie: `__Host-oauth_flow=${cookie}` },
        });

        return { start, back, verifier };
    };

    return { ...test, http, webApp, logIn };
};

Deno.test("migrating registers Verso Web once, as a public app with every scope", async () => {
    await using test = await open();
    const urls = urlBuilder("social.example");

    assertEquals(await ensureWebApp(test.ctx, urls), "added");
    assertEquals(await ensureWebApp(test.ctx, urls), "unchanged");

    const app = await test.webApp();
    await using fresh = await createTestContext();
    assertEquals(webClientId, "verso-web");
    assertEquals([app?.id, app?.created_at], [fresh.ctx.ids(), test.ctx.clock.now()]);
    assertEquals(
        [app?.name, app?.website, app?.redirect_uris, app?.scopes, app?.client_secret_hash],
        [
            "Verso Web",
            "https://social.example/",
            ["https://social.example/oauth/web-callback"],
            [...scopes],
            null,
        ],
    );
    assertEquals(
        (await test.ctx.db.selectFrom("apps").select("id").execute()).length,
        1,
    );
});

const drifts: Record<string, Parameters<typeof updateApp>[2]> = {
    name: { name: "Old" },
    website: { website: null },
    "redirect URIs": { redirect_uris: ["https://old.example/oauth/web-callback"] },
    scopes: { scopes: ["read"] },
    secret: { client_secret_hash: "stray" },
};

for (const [field, drift] of Object.entries(drifts)) {
    Deno.test(`migrating again restores Verso Web's ${field}, keeping its id`, async () => {
        await using test = await open();
        const urls = urlBuilder("social.example");
        await ensureWebApp(test.ctx, urls);
        const { app: other } = await registerTestApp(test.ctx);
        const before = await test.webApp();
        await updateApp(test.ctx, before?.id ?? "", drift);

        assertEquals(await ensureWebApp(test.ctx, urls), "updated");
        assertEquals(await test.webApp(), before);
        assertEquals(await findAppByClientId(test.ctx, other.client_id), other);
    });
}

Deno.test("migrating with a new origin moves Verso Web's redirect", async () => {
    await using test = await open();
    await ensureWebApp(test.ctx, urlBuilder("social.example"));

    const change = await ensureWebApp(
        test.ctx,
        urlBuilder("social.example", "http://localhost:8080"),
    );
    const app = await test.webApp();

    assertEquals(change, "updated");
    assertEquals(
        [app?.website, app?.redirect_uris],
        ["http://localhost:8080/", ["http://localhost:8080/oauth/web-callback"]],
    );
});

Deno.test("Verso Web gets its code without asking, and exchanges it without a secret", async () => {
    await using test = await open();
    await ensureWebApp(test.ctx, test.ctx.urls);
    const redirectUri = "https://social.example/oauth/web-callback";

    const { back, verifier } = await test.logIn(webClientId, redirectUri);
    const location = new URL(back.headers.get("location") ?? "");

    assertEquals(back.status, 302);
    assertEquals(location.origin + location.pathname, redirectUri);
    assertEquals(location.searchParams.get("state"), "xyz");

    const token = await test.http.request("/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
            client_id: webClientId,
            grant_type: "authorization_code",
            code: location.searchParams.get("code") ?? "",
            redirect_uri: redirectUri,
            code_verifier: verifier,
        }),
    });

    assertEquals([token.status, (await token.json()).scope], [200, "read write"]);
});

Deno.test("Verso Web can't be sent anywhere else", async () => {
    await using test = await open();
    await ensureWebApp(test.ctx, test.ctx.urls);

    const { start } = await test.logIn(webClientId, "https://evil.example/oauth/web-callback");

    assertEquals([start.status, flowCookie(start)], [400, ""]);
    assertEquals(await test.ctx.db.selectFrom("oauth_flows").selectAll().execute(), []);
});

Deno.test("other public apps are still asked for", async () => {
    await using test = await open();
    await ensureWebApp(test.ctx, test.ctx.urls);
    const { app } = await registerTestApp(test.ctx, { confidential: false });

    const { back } = await test.logIn(app.client_id, "https://phanpy.example/back");

    assertEquals(back.status, 303);
    assertEquals(back.headers.get("location"), "https://social.example/oauth/consent");
});
