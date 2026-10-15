import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../http/app.ts";
import { queues, tasks } from "../jobs/queues.ts";
import { schedule } from "../jobs/scheduler.ts";
import { drain } from "../jobs/worker.ts";
import type { IdentityProvider } from "../kernel/identity.ts";
import { createTestContext } from "../kernel/testing.ts";
import { authRoutes } from "./routes.ts";
import { hashToken } from "./secrets.ts";
import { flowCookie, formTokenIn, registerTestApp, stubProvider } from "./testing.ts";

const issuerA = stubProvider({ url: "https://a.example", name: "Example A" });
const issuerDown: IdentityProvider = {
    ...stubProvider({ url: "https://down.example", name: "Example Down" }),
    beginLogin: () => Promise.reject(new TypeError("Connection refused")),
};
const issuerB = stubProvider({ url: "https://b.example", name: "Example B" });

const open = async (providers: IdentityProvider[] = [issuerA]) => {
    const test = await createTestContext({
        identityProviders: Object.fromEntries(providers.map((p) => [p.issuer.url, p])),
    });
    const http = createApp(test.ctx, authRoutes, { checkResponses: true });

    const { app } = await registerTestApp(test.ctx);

    /** Opens `/oauth/authorize` with a valid request, changed by `changes`. */
    const authorize = (changes: Record<string, string | undefined> = {}) => {
        const params = {
            client_id: app.client_id,
            redirect_uri: "https://phanpy.example/back",
            response_type: "code",
            state: "xyz",
            ...changes,
        };
        const defined = Object.entries(params).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
        );

        return http.request(`/oauth/authorize?${new URLSearchParams(defined)}`);
    };

    const chooseIssuer = (
        issuer: string,
        cookie?: string,
        formToken = "none",
        site = "same-origin",
    ) => http.request("/oauth/authorize/issuer", {
        method: "POST",
        body: new URLSearchParams({ issuer, form_token: formToken }),
        headers: {
            "sec-fetch-site": site,
            ...(cookie === undefined ? {} : { cookie: `__Host-oauth_flow=${cookie}` }),
        },
    });

    const flows = () => test.ctx.db.selectFrom("oauth_flows").selectAll().execute();

    return { ...test, app, authorize, chooseIssuer, flows };
};

/** The chooser's cookie and form token, as the browser has them. */
const chooser = async (response: Response) => ({
    cookie: flowCookie(response),
    formToken: formTokenIn(await response.text()),
});

Deno.test("with one issuer, the browser goes straight to it, tied to the flow by a cookie", async () => {
    await using test = await open();

    const response = await test.authorize({
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
    });
    const [flow] = await test.flows();

    assertEquals(response.status, 302);
    assertEquals(
        response.headers.get("location"),
        "https://a.example/authorize?back=https%3A%2F%2Fsocial.example%2Foauth%2Fcallback",
    );
    assertEquals(flow.id, await hashToken(flowCookie(response)));
    assertEquals([flow.app_id, flow.scopes, flow.state, flow.code_challenge, flow.issuer], [
        test.app.id,
        ["read"],
        "xyz",
        "a".repeat(43),
        "https://a.example",
    ]);
    assertEquals(flow.login?.redirectUri, "https://social.example/oauth/callback");
});

Deno.test("a wrong app or redirect URI is shown to the user, never redirected to", async () => {
    await using test = await open();

    for (
        const changes of [
            { client_id: "unknown" },
            { client_id: undefined },
            { redirect_uri: "https://evil.example/back" },
            { redirect_uri: undefined },
        ]
    ) {
        const response = await test.authorize(changes);

        assertEquals(response.status, 400);
        assertEquals(response.headers.get("content-type"), "text/html; charset=UTF-8");
    }

    assertEquals(await test.flows(), []);
});

Deno.test("other errors go back to the app, with its state", async () => {
    await using test = await open();

    const errorOf = async (changes: Record<string, string | undefined>) => {
        const location = new URL((await test.authorize(changes)).headers.get("location") ?? "");
        assertEquals(location.origin + location.pathname, "https://phanpy.example/back");
        assertEquals(location.searchParams.get("state"), "xyz");
        return location.searchParams.get("error");
    };

    assertEquals(await errorOf({ response_type: "token" }), "unsupported_response_type");
    assertEquals(await errorOf({ response_type: undefined }), "invalid_request");
    assertEquals(await errorOf({ scope: "read push" }), "invalid_scope");
    assertEquals(await errorOf({ scope: "read bogus" }), "invalid_scope");
    assertEquals(await errorOf({ code_challenge: "a".repeat(43) }), "invalid_request");
    assertEquals(
        await errorOf({ code_challenge: "a".repeat(43), code_challenge_method: "plain" }),
        "invalid_request",
    );
    assertEquals(
        await errorOf({ code_challenge: "short", code_challenge_method: "S256" }),
        "invalid_request",
    );
    assertEquals(await test.flows(), []);
});

Deno.test("an out-of-band app is shown its errors, having no redirect to send them to", async () => {
    await using test = await open();

    const response = await test.authorize({
        redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
        scope: "push",
    });

    assertEquals(response.status, 400);
    assertStringIncludes(await response.text(), "didn&#39;t register all of these scopes");
});

Deno.test("without issuers, nobody can log in", async () => {
    await using test = await open([]);

    assertEquals((await test.authorize()).status, 400);
});

Deno.test("with several issuers, the user chooses, in the browser that started", async () => {
    await using test = await open([issuerA, issuerB]);

    const response = await test.authorize();
    const page = await response.clone().text();
    const { cookie, formToken } = await chooser(response);

    assertEquals(response.status, 200);
    assertStringIncludes(
        page,
        `<button name="issuer" value="https://b.example">Example B</button>`,
    );

    assertEquals((await test.chooseIssuer("https://b.example", undefined, formToken)).status, 400);
    assertEquals((await test.chooseIssuer("https://b.example", "other", formToken)).status, 400);
    assertEquals((await test.chooseIssuer("https://b.example", cookie)).status, 400);
    assertEquals((await test.chooseIssuer("https://c.example", cookie, formToken)).status, 400);
    assertEquals((await test.chooseIssuer("constructor", cookie, formToken)).status, 400);
    assertEquals(
        (await test.chooseIssuer("https://b.example", cookie, formToken, "same-site")).status,
        422,
    );

    const chosen = await test.chooseIssuer("https://b.example", cookie, formToken);

    assertEquals(chosen.status, 303);
    assertStringIncludes(chosen.headers.get("location") ?? "", "https://b.example/authorize");
    assertEquals((await test.flows())[0].issuer, "https://b.example");
});

Deno.test("if the issuer can't be reached, the user is told, and nothing is stored", async () => {
    await using only = await open([issuerDown]);
    await using several = await open([issuerA, issuerDown]);

    const direct = await only.authorize();
    const { cookie, formToken } = await chooser(await several.authorize());
    const chosen = await several.chooseIssuer("https://down.example", cookie, formToken);

    assertEquals(direct.status, 502);
    assertStringIncludes(await direct.text(), "Can&#39;t reach Example Down right now");
    assertEquals(await only.flows(), []);

    assertEquals(chosen.status, 502);
    assertEquals((await several.flows())[0].issuer, null);
});

Deno.test("a login must be finished within half an hour", async () => {
    await using test = await open([issuerA, issuerB]);
    const { cookie, formToken } = await chooser(await test.authorize());

    test.clock.advance(30 * 60_000);

    assertEquals((await test.chooseIssuer("https://a.example", cookie, formToken)).status, 400);
});

Deno.test("each hour, flows past their expiry are deleted", async () => {
    await using test = await open();
    await test.authorize();
    test.clock.advance(20 * 60_000);
    await test.authorize();

    test.clock.advance(10 * 60_000);
    await schedule(test.ctx, tasks);
    await drain(test.ctx, queues);

    assertEquals((await test.flows()).length, 1);
});
