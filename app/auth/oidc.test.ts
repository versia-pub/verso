import { assertEquals, assertRejects } from "@std/assert";
import type { Issuer } from "../accounts/provision.ts";
import { fakeClock } from "../kernel/clock.ts";
import { fakeTransport } from "../kernel/fake_transport.ts";
import { createFakeIdentityProvider } from "../testing/fake_idp.ts";
import { oidcProvider } from "./oidc.ts";

const redirectUri = "https://social.example/oauth/callback";

const open = async () => {
    // Years before the real time, so ID tokens would look expired unless the adapter uses it.
    const clock = fakeClock(new Date("2020-01-01T00:00:00Z"));
    const idp = await createFakeIdentityProvider({
        client: { id: "verso", secret: "s3cret" },
        clock,
    });
    const transport = fakeTransport({ "idp.test": idp.app.fetch });

    const issuer: Issuer = {
        name: "Example ID",
        url: idp.issuer,
        client_id: "verso",
        client_secret: "s3cret",
        username_claim: "preferred_username",
        registration: "open",
    };
    const provider = oidcProvider(issuer, "s3cret", { transport, clock });

    /** Starts a login and follows the issuer's redirect back, as a browser would. */
    const login = async () => {
        const { url, flow } = await provider.beginLogin(redirectUri);
        const response = await transport(new Request(url));
        return { flow, callback: new URL(response.headers.get("location") ?? "") };
    };

    return { clock, idp, transport, provider, login };
};

Deno.test("a login returns the verified claims, on the context's clock", async () => {
    const test = await open();
    test.idp.login = { sub: "u1", preferred_username: "alice" };

    const { flow, callback } = await test.login();
    test.clock.advance(60 * 60_000);
    const claims = await test.provider.completeLogin(callback, flow);

    assertEquals(callback.origin + callback.pathname, redirectUri);
    assertEquals([claims.iss, claims.sub, claims.preferred_username], [
        "https://idp.test",
        "u1",
        "alice",
    ]);
});

Deno.test("a callback for another login is refused", async () => {
    const test = await open();
    const first = await test.login();
    const second = await test.login();

    await assertRejects(() => test.provider.completeLogin(second.callback, first.flow));
});

Deno.test("an error from the issuer is refused", async () => {
    const test = await open();
    const { flow } = await test.login();

    const denied = new URL(`${redirectUri}?error=access_denied&state=${flow.state}`);

    await assertRejects(() => test.provider.completeLogin(denied, flow));
});

Deno.test("if the issuer can't be reached, the next login discovers it again", async () => {
    const test = await open();
    test.transport.down.add("idp.test");

    await assertRejects(() => test.provider.beginLogin(redirectUri));

    test.transport.down.delete("idp.test");
    const { flow, callback } = await test.login();
    assertEquals((await test.provider.completeLogin(callback, flow)).sub, "alice");
});
