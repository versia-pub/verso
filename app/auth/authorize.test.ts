import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../http/app.ts";
import { createTestContext } from "../kernel/testing.ts";
import { registerApp } from "./apps.ts";
import type { IdentityProvider } from "./identity.ts";
import { authRoutes } from "./routes.ts";
import { hashToken } from "./secrets.ts";

/** An issuer that sends the browser to its own `/authorize`, naming where it should come back. */
const stubProvider = (url: string, name: string): IdentityProvider => ({
    issuer: {
        name,
        url,
        client_id: "verso",
        client_secret: "s3cret",
        username_claim: "preferred_username",
        registration: "open",
    },
    beginLogin: (redirectUri) =>
        Promise.resolve({
            url: new URL(`${url}/authorize?back=${encodeURIComponent(redirectUri)}`),
            flow: { redirectUri, state: "s", nonce: "n", codeVerifier: "v" },
        }),
    completeLogin: () => Promise.reject(new Error("Not used here")),
});

const issuerA = stubProvider("https://a.example", "Example A");

const open = async (providers: IdentityProvider[] = [issuerA]) => {
    const test = await createTestContext({
        identityProviders: Object.fromEntries(providers.map((p) => [p.issuer.url, p])),
    });
    const http = createApp(test.ctx, authRoutes, { checkResponses: true });

    const { app } = await registerApp(test.ctx, {
        name: "Phanpy",
        website: null,
        redirectUris: ["https://phanpy.example/back", "urn:ietf:wg:oauth:2.0:oob"],
        scopes: ["read", "write"],
    });

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

    const flows = () => test.ctx.db.selectFrom("oauth_flows").selectAll().execute();

    return { ...test, app, authorize, flows };
};

const flowCookie = (response: Response) =>
    /__Host-oauth_flow=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? "";

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
