import { assertEquals, assertRejects } from "@std/assert";
import * as client from "@panva/openid-client";
import { openidFetch } from "../auth/oidc.ts";
import { fakeTransport } from "../kernel/fake_transport.ts";
import { createFakeIdentityProvider } from "./fake_idp.ts";

const redirectUri = "https://social.example/oauth/callback";

const open = async () => {
    const idp = await createFakeIdentityProvider({ client: { id: "verso", secret: "s3cret" } });
    const transport = fakeTransport({ "idp.test": idp.app.fetch });

    const config = await client.discovery(
        new URL(idp.issuer),
        "verso",
        "s3cret",
        undefined,
        { [client.customFetch]: openidFetch(transport) },
    );

    /** Starts a login and follows the redirect back, as a browser would. */
    const login = async () => {
        const verifier = client.randomPKCECodeVerifier();
        const nonce = client.randomNonce();
        const state = client.randomState();
        const url = client.buildAuthorizationUrl(config, {
            redirect_uri: redirectUri,
            scope: "openid profile",
            code_challenge: await client.calculatePKCECodeChallenge(verifier),
            code_challenge_method: "S256",
            nonce,
            state,
        });

        const response = await transport(new Request(url));
        const callback = new URL(response.headers.get("location") ?? "");
        return { verifier, nonce, state, callback };
    };

    const finish = (flow: Awaited<ReturnType<typeof login>>, verifier = flow.verifier) =>
        client.authorizationCodeGrant(config, flow.callback, {
            pkceCodeVerifier: verifier,
            expectedNonce: flow.nonce,
            expectedState: flow.state,
        });

    return { idp, login, finish };
};

Deno.test("openid-client logs in through the fake provider and reads the claims", async () => {
    const test = await open();
    test.idp.login = { sub: "u1", preferred_username: "Alice" };

    const tokens = await test.finish(await test.login());

    const claims = tokens.claims();
    assertEquals(claims?.iss, "https://idp.test");
    assertEquals(claims?.sub, "u1");
    assertEquals(claims?.preferred_username, "Alice");
});

Deno.test("a code works only once", async () => {
    const test = await open();
    const flow = await test.login();

    await test.finish(flow);

    await assertRejects(() => test.finish(flow));
});

Deno.test("a code is refused with the wrong PKCE verifier", async () => {
    const test = await open();
    const flow = await test.login();

    await assertRejects(() => test.finish(flow, client.randomPKCECodeVerifier()));
});
