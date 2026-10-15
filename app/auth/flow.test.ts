import { assertEquals, assertStringIncludes } from "@std/assert";
import type { IssuerConfig } from "../kernel/identity.ts";
import { createApp } from "../http/app.ts";
import { routes } from "../http/routes.ts";
import { fakeClock } from "../kernel/clock.ts";
import { fakeTransport } from "../kernel/fake_transport.ts";
import { createTestContext } from "../kernel/testing.ts";
import { createFakeIdentityProvider } from "../testing/fake_idp.ts";
import { oidcProvider } from "./oidc.ts";
import { hashToken, randomToken } from "./secrets.ts";

const issuer: IssuerConfig = {
    name: "Example ID",
    url: "https://idp.test",
    client_id: "verso",
    client_secret: "s3cret",
    username_claim: "preferred_username",
    registration: "open",
};

const open = async () => {
    const clock = fakeClock();
    const idp = await createFakeIdentityProvider({
        client: { id: "verso", secret: "s3cret" },
        clock,
    });
    const transport = fakeTransport({ "idp.test": idp.app.fetch });

    const test = await createTestContext({
        clock,
        transport,
        identityProviders: {
            [issuer.url]: oidcProvider(issuer, { transport, clock }),
        },
    });
    const verso = createApp(test.ctx, routes, { checkResponses: true });

    /** A browser that sends Verso's requests to Verso and the rest to the network, with cookies. */
    let cookie = "";
    const browse = async (url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (cookie) headers.set("cookie", cookie);

        const request = new Request(url, { ...init, headers });
        const response = new URL(url).host === "social.example"
            ? await verso.request(request)
            : await transport(request);

        const set = /(__Host-oauth_flow=[^;]*)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
        if (set !== undefined) cookie = set;

        return response;
    };

    const api = async (path: string, init: RequestInit = {}) => {
        const response = await verso.request(path, init);
        return { status: response.status, body: await response.json() };
    };

    return { ...test, idp, browse, api };
};

const locationOf = (response: Response) => response.headers.get("location") ?? "";

Deno.test("a client logs a user in through the issuer and uses the token", async () => {
    await using test = await open();
    test.idp.login = { sub: "u1", preferred_username: "alice" };

    // The client registers, and starts the login with PKCE.
    const { body: app } = await test.api("/api/v1/apps", {
        method: "POST",
        body: JSON.stringify({
            client_name: "Phanpy",
            redirect_uris: "https://phanpy.example/back",
            scopes: "read write",
        }),
        headers: { "content-type": "application/json" },
    });
    const verifier = randomToken();
    const authorize = new URLSearchParams({
        client_id: app.client_id,
        redirect_uri: "https://phanpy.example/back",
        response_type: "code",
        scope: "read write",
        state: "xyz",
        code_challenge: await hashToken(verifier),
        code_challenge_method: "S256",
    });

    // The browser goes to the issuer, back to Verso, and on to the consent page.
    const toIssuer = await test.browse(`https://social.example/oauth/authorize?${authorize}`);
    const fromIssuer = await test.browse(locationOf(toIssuer));
    const toConsent = await test.browse(locationOf(fromIssuer));
    const consent = await (await test.browse(locationOf(toConsent))).text();
    const formToken = /name="form_token" value="([^"]+)"/.exec(consent)?.[1] ?? "";

    assertEquals(toConsent.status, 303);
    assertStringIncludes(consent, "@alice");

    // The user allows the app, which gets a code with its state.
    const allowed = await test.browse("https://social.example/oauth/consent", {
        method: "POST",
        body: new URLSearchParams({ decision: "allow", form_token: formToken }),
    });
    const back = new URL(locationOf(allowed));

    assertEquals(back.origin + back.pathname, "https://phanpy.example/back");
    assertEquals(back.searchParams.get("state"), "xyz");

    // The client trades the code for a token, and uses it.
    const credentials = { client_id: app.client_id, client_secret: app.client_secret };
    const { status, body: token } = await test.api("/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
            ...credentials,
            grant_type: "authorization_code",
            code: back.searchParams.get("code") ?? "",
            redirect_uri: "https://phanpy.example/back",
            code_verifier: verifier,
        }),
    });
    const bearer = { authorization: `Bearer ${token.access_token}` };

    assertEquals([status, token.scope], [200, "read write"]);
    assertEquals(
        (await test.api("/api/v1/apps/verify_credentials", { headers: bearer })).body.name,
        "Phanpy",
    );

    // Once revoked, the token stops working.
    await test.api("/oauth/revoke", {
        method: "POST",
        body: new URLSearchParams({ ...credentials, token: token.access_token }),
    });

    assertEquals(
        (await test.api("/api/v1/apps/verify_credentials", { headers: bearer })).status,
        401,
    );
});
