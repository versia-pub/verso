import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../http/app.ts";
import type { AppRegistration } from "./apps.ts";
import { createTestContext } from "../kernel/testing.ts";
import { authRoutes } from "./routes.ts";
import { hashToken } from "./secrets.ts";
import { flowCookie, formTokenIn, registerTestApp, stubProvider } from "./testing.ts";

const open = async (provider = stubProvider(), registration: Partial<AppRegistration> = {}) => {
    const test = await createTestContext({
        identityProviders: { [provider.issuer.url]: provider },
    });
    const http = createApp(test.ctx, authRoutes, { checkResponses: true });

    const { app } = await registerTestApp(test.ctx, registration);

    const request = (
        path: string,
        cookie: string | undefined,
        init: RequestInit = {},
        headers: Record<string, string> = {},
    ) => http.request(path, {
        ...init,
        headers: cookie === undefined ? headers : {
            ...headers,
            cookie: `__Host-oauth_flow=${cookie}`,
        },
    });

    /** Starts a flow and returns its cookie. */
    const start = async (redirectUri = "https://phanpy.example/back") => {
        const params = new URLSearchParams({
            client_id: app.client_id,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: "read write",
            state: "xyz",
        });
        const response = await http.request(`/oauth/authorize?${params}`);

        return flowCookie(response);
    };

    const callback = (cookie: string | undefined, code = "good") =>
        request(`/oauth/callback?code=${code}&state=s`, cookie);

    const chooseIssuer = (cookie: string) =>
        request("/oauth/authorize/issuer", cookie, {
            method: "POST",
            body: new URLSearchParams({ issuer: "https://id.example", form_token: "none" }),
        });

    const consent = (cookie: string | undefined) => request("/oauth/consent", cookie);

    /** Answers on the consent page, as shown now unless an older one's form token is given. */
    const decide = async (
        cookie: string | undefined,
        decision: "allow" | "deny",
        { formToken, site = "same-origin" }: { formToken?: string; site?: string } = {},
    ) => request("/oauth/consent", cookie, {
        method: "POST",
        body: new URLSearchParams({
            decision,
            form_token: formToken ?? formTokenIn(await (await consent(cookie)).text()),
        }),
    }, { "sec-fetch-site": site });

    const flows = () => test.ctx.db.selectFrom("oauth_flows").selectAll().execute();

    return { ...test, start, callback, chooseIssuer, consent, decide, flows };
};

const backTo = (response: Response) => new URL(response.headers.get("location") ?? "");

Deno.test("after logging in, the user is asked to allow the app", async () => {
    await using test = await open();
    const cookie = await test.start();

    const back = await test.callback(cookie);
    const page = await (await test.consent(cookie)).text();

    assertEquals(back.status, 303);
    assertEquals(back.headers.get("location"), "https://social.example/oauth/consent");
    assertStringIncludes(page, "<title>Allow Phanpy?</title>");
    assertStringIncludes(page, "@alice");
    assertStringIncludes(page, "<li><code>write</code></li>");
});

Deno.test("allowing sends the app a single-use code with its state", async () => {
    await using test = await open();
    const cookie = await test.start();
    await test.callback(cookie);

    const allowed = await test.decide(cookie, "allow");
    const code = backTo(allowed).searchParams.get("code") ?? "";
    const [flow] = await test.flows();

    assertEquals(allowed.status, 302);
    assertEquals(backTo(allowed).searchParams.get("state"), "xyz");
    assertEquals(flow.code_hash, await hashToken(code));
    assertEquals(flow.expires_at.getTime() - test.clock.now().getTime(), 10 * 60_000);
    assertStringIncludes(allowed.headers.get("set-cookie") ?? "", "__Host-oauth_flow=; Max-Age=0");

    assertEquals((await test.decide(cookie, "allow")).status, 400);
    assertEquals((await test.consent(cookie)).status, 400);
});

Deno.test("allowing twice at once gives one code", async () => {
    await using test = await open();
    const cookie = await test.start();
    await test.callback(cookie);

    const answers = await Promise.all([test.decide(cookie, "allow"), test.decide(cookie, "allow")]);

    assertEquals(answers.map((answer) => answer.status).toSorted(), [302, 400]);
});

Deno.test("denying tells the app, and ends the flow", async () => {
    await using test = await open();
    const cookie = await test.start();
    await test.callback(cookie);

    const denied = await test.decide(cookie, "deny");

    assertEquals(backTo(denied).searchParams.get("error"), "access_denied");
    assertEquals(backTo(denied).searchParams.get("state"), "xyz");
    assertEquals(await test.flows(), []);
});

Deno.test("an out-of-band app's user is shown the code to copy", async () => {
    await using test = await open();
    const cookie = await test.start("urn:ietf:wg:oauth:2.0:oob");
    await test.callback(cookie);

    const allowed = await test.decide(cookie, "allow");
    const [flow] = await test.flows();
    const code = /<code>([^<]+)<\/code>/.exec(await allowed.text())?.[1] ?? "";

    assertEquals(allowed.status, 200);
    assertEquals(flow.code_hash, await hashToken(code));
});

Deno.test("a failed login, or a closed registration, is denied to the app, and ends the flow", async () => {
    await using failed = await open();
    await using closed = await open(stubProvider({ registration: "closed" }));

    const notLoggedIn = await failed.callback(await failed.start(), "bad");
    const notRegistered = await closed.callback(await closed.start());

    assertEquals(backTo(notLoggedIn).searchParams.get("error"), "access_denied");
    assertEquals(backTo(notRegistered).searchParams.get("error"), "access_denied");
    assertEquals(await closed.ctx.db.selectFrom("accounts").selectAll().execute(), []);
    for (const [test, response] of [[failed, notLoggedIn], [closed, notRegistered]] as const) {
        assertEquals(await test.flows(), []);
        assertStringIncludes(
            response.headers.get("set-cookie") ?? "",
            "__Host-oauth_flow=; Max-Age=0",
        );
    }
});

Deno.test("each step needs the browser that started, in the right order", async () => {
    await using test = await open();
    const cookie = await test.start();

    assertEquals((await test.consent(cookie)).status, 400);
    assertEquals((await test.decide(cookie, "allow")).status, 400);
    assertEquals((await test.callback(undefined)).status, 400);
    assertEquals((await test.callback("other")).status, 400);

    assertEquals((await test.callback(cookie)).status, 303);
    assertEquals((await test.callback(cookie)).status, 400);
    assertEquals((await test.chooseIssuer(cookie)).status, 400);
    assertEquals((await test.consent(undefined)).status, 400);
    assertEquals((await test.decide(undefined, "allow")).status, 400);
    assertEquals((await test.consent(cookie)).status, 200);
});

Deno.test("a consent page left open from an older login can't answer for a newer one", async () => {
    await using test = await open();
    const first = await test.start();
    await test.callback(first);
    const olderPage = await (await test.consent(first)).text();

    const second = await test.start();
    await test.callback(second);
    const older = await test.decide(second, "allow", { formToken: formTokenIn(olderPage) });

    assertEquals(older.status, 400);
    assertEquals((await test.flows()).map((flow) => flow.code_hash), [null, null]);
    assertEquals((await test.decide(second, "allow")).status, 302);
});

Deno.test("only Verso's own pages can answer", async () => {
    await using test = await open();
    const cookie = await test.start();
    await test.callback(cookie);

    assertEquals((await test.decide(cookie, "allow", { site: "same-site" })).status, 422);
    assertEquals((await test.decide(cookie, "allow", { site: "cross-site" })).status, 422);
    assertEquals((await test.flows())[0].code_hash, null);
});

Deno.test("the app's name is shown as text, never as HTML", async () => {
    await using test = await open(stubProvider(), { name: `<script>alert("hi")</script>` });
    const cookie = await test.start();
    await test.callback(cookie);

    const page = await (await test.consent(cookie)).text();

    assertEquals(page.includes("<script>"), false);
    assertStringIncludes(page, "&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt; wants to use");
});

Deno.test("a redirect URI with a query keeps it, with the code added", async () => {
    const redirectUri = "https://phanpy.example/back?from=verso";
    await using test = await open(stubProvider(), { redirectUris: [redirectUri] });
    const cookie = await test.start(redirectUri);
    await test.callback(cookie);

    const back = backTo(await test.decide(cookie, "allow"));

    assertEquals(back.origin + back.pathname, "https://phanpy.example/back");
    assertEquals([...back.searchParams.keys()], ["from", "code", "state"]);
    assertEquals(back.searchParams.get("from"), "verso");
});
