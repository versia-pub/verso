import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../http/app.ts";
import { routes } from "../http/routes.ts";
import { createTestContext } from "../kernel/testing.ts";
import { urlBuilder } from "../kernel/urls.ts";
import { registerApp } from "./apps.ts";
import { devIssuer, devLoginProvider, devLoginRoutes } from "./dev_login.ts";

const open = async () => {
    const urls = urlBuilder("social.example");
    const test = await createTestContext({
        identityProviders: { [devIssuer(urls).url]: devLoginProvider(urls) },
    });
    const verso = createApp(test.ctx, [...routes, ...devLoginRoutes], { checkResponses: true });

    const { app } = await registerApp(test.ctx, {
        name: "Phanpy",
        website: null,
        redirectUris: ["https://phanpy.example/back"],
        scopes: ["read"],
    });

    /** Starts a login, and returns its cookie and the dev login page's URL. */
    const start = async () => {
        const params = new URLSearchParams({
            client_id: app.client_id,
            redirect_uri: "https://phanpy.example/back",
            response_type: "code",
        });
        const response = await verso.request(`/oauth/authorize?${params}`);
        const set = response.headers.get("set-cookie") ?? "";

        return {
            cookie: /(__Host-oauth_flow=[^;]*)/.exec(set)?.[1] ?? "",
            page: new URL(response.headers.get("location") ?? ""),
        };
    };

    const browse = (path: string, cookie: string) => verso.request(path, { headers: { cookie } });

    return { ...test, verso, start, browse };
};

Deno.test("in development, a user logs in as any username", async () => {
    await using test = await open();
    const { cookie, page } = await test.start();

    const form = await (await test.browse(page.pathname + page.search, cookie)).text();
    const state = page.searchParams.get("state") ?? "";
    const back = await test.browse(`/oauth/callback?state=${state}&username=alice`, cookie);
    const consent = await (await test.browse("/oauth/consent", cookie)).text();

    assertEquals(page.origin + page.pathname, "https://social.example/oauth/dev-login");
    assertStringIncludes(form, `<input type="hidden" name="state" value="${state}">`);
    assertEquals(back.headers.get("location"), "https://social.example/oauth/consent");
    assertStringIncludes(consent, "@alice");
});

Deno.test("a dev login with another state, or no username, is denied", async () => {
    await using test = await open();

    for (const query of ["state=forged&username=alice", "state=STATE"]) {
        const { cookie, page } = await test.start();
        const state = page.searchParams.get("state") ?? "";

        const back = await test.browse(`/oauth/callback?${query.replace("STATE", state)}`, cookie);

        assertEquals(
            new URL(back.headers.get("location") ?? "").searchParams.get("error"),
            "access_denied",
        );
    }
});

Deno.test("without the dev login, its page doesn't exist", async () => {
    await using test = await open();
    const verso = createApp(test.ctx, routes);

    assertEquals((await verso.request("/oauth/dev-login?state=s")).status, 404);
});
