import { assertEquals } from "@std/assert";
import { createApp } from "../http/app.ts";
import { createTestContext } from "../kernel/testing.ts";
import { registerApp } from "./apps.ts";
import { authRoutes } from "./routes.ts";
import { hashToken, randomToken } from "./secrets.ts";

const open = async () => {
    const test = await createTestContext();
    const http = createApp(test.ctx, authRoutes, { checkResponses: true });

    const { app, clientSecret } = await registerApp(test.ctx, {
        name: "Phanpy",
        website: null,
        redirectUris: ["https://phanpy.example/back"],
        scopes: ["read", "write"],
    });

    const token = async (form: Record<string, string>, authorization?: string) => {
        const response = await http.request("/oauth/token", {
            method: "POST",
            body: new URLSearchParams(form),
            headers: authorization === undefined ? {} : { authorization },
        });

        return { status: response.status, body: await response.json() };
    };

    const credentials = { client_id: app.client_id, client_secret: clientSecret };
    const basic = (id: string, secret: string) => `Basic ${btoa(`${id}:${secret}`)}`;

    await test.ctx.db.insertInto("accounts")
        .values({
            id: "alice",
            username: "alice",
            instance_id: null,
            remote_id: null,
            created_at: test.clock.now(),
        })
        .execute();

    /** A code alice allowed, as the consent page leaves it, valid for ten minutes. */
    const allowedCode = async (challenge: string | null = null) => {
        const code = randomToken();

        await test.ctx.db.insertInto("oauth_flows")
            .values({
                id: test.ctx.ids(),
                app_id: app.id,
                redirect_uri: "https://phanpy.example/back",
                scopes: ["read", "write"],
                state: null,
                code_challenge: challenge,
                issuer: "https://id.example",
                login: null,
                account_id: "alice",
                code_hash: await hashToken(code),
                expires_at: new Date(test.clock.now().getTime() + 10 * 60_000),
                created_at: test.clock.now(),
            })
            .execute();

        return code;
    };

    const exchange = (code: string, changes: Record<string, string> = {}) =>
        token({
            ...credentials,
            grant_type: "authorization_code",
            code,
            redirect_uri: "https://phanpy.example/back",
            ...changes,
        });

    const revoke = async (form: Record<string, string>) => {
        const response = await http.request("/oauth/revoke", {
            method: "POST",
            body: new URLSearchParams(form),
        });

        return { status: response.status, body: await response.json() };
    };

    return { ...test, app, credentials, basic, token, allowedCode, exchange, revoke };
};

Deno.test("an app gets a token for itself, stored only as a hash", async () => {
    await using test = await open();

    const { status, body } = await test.token({
        ...test.credentials,
        grant_type: "client_credentials",
        scope: "write read",
    });
    const [stored] = await test.ctx.db.selectFrom("access_tokens").selectAll().execute();

    assertEquals(status, 200);
    assertEquals(body.token_type, "Bearer");
    assertEquals(body.scope, "write read");
    assertEquals(body.created_at, Math.floor(test.clock.now().getTime() / 1000));
    assertEquals(stored.token_hash, await hashToken(body.access_token));
    assertEquals([stored.app_id, stored.account_id, stored.scopes], [
        test.app.id,
        null,
        ["write", "read"],
    ]);
});

Deno.test("credentials can come by HTTP Basic, which wins over the form", async () => {
    await using test = await open();
    const { client_id, client_secret } = test.credentials;

    const { status, body } = await test.token(
        { grant_type: "client_credentials", client_id, client_secret: "wrong" },
        test.basic(client_id, client_secret),
    );

    assertEquals(status, 200);
    assertEquals(body.scope, "read");
});

Deno.test("wrong or missing credentials are an invalid client", async () => {
    await using test = await open();
    const { client_id, client_secret } = test.credentials;
    const grant = { grant_type: "client_credentials" };

    const attempts = [
        await test.token({ ...grant, client_id, client_secret: "wrong" }),
        await test.token({ ...grant, client_id: "unknown", client_secret }),
        await test.token({ ...grant, client_id }),
        await test.token(grant, test.basic(client_id, "wrong")),
        await test.token(grant, "Basic not-base64!"),
        await test.token(grant, `Basic ${btoa("no colon")}`),
    ];

    for (const { status, body } of attempts) {
        assertEquals([status, body.error], [401, "invalid_client"]);
    }
});

Deno.test("an unknown grant or scope is refused in OAuth's shape", async () => {
    await using test = await open();

    const password = await test.token({ ...test.credentials, grant_type: "password" });
    const missing = await test.token(test.credentials);
    const push = await test.token({
        ...test.credentials,
        grant_type: "client_credentials",
        scope: "read push",
    });

    assertEquals([password.status, password.body.error], [400, "unsupported_grant_type"]);
    assertEquals([missing.status, missing.body.error], [400, "unsupported_grant_type"]);
    assertEquals([push.status, push.body.error], [400, "invalid_scope"]);
    assertEquals(await test.ctx.db.selectFrom("access_tokens").selectAll().execute(), []);
});

Deno.test("a code becomes a token for the user who allowed it, once", async () => {
    await using test = await open();
    const code = await test.allowedCode();

    const first = await test.exchange(code, { scope: "read" });
    const again = await test.exchange(code);
    const [stored] = await test.ctx.db.selectFrom("access_tokens").selectAll().execute();

    assertEquals(first.status, 200);
    assertEquals(first.body.scope, "read write");
    assertEquals([stored.account_id, stored.token_hash], [
        "alice",
        await hashToken(first.body.access_token),
    ]);
    assertEquals([again.status, again.body.error], [400, "invalid_grant"]);
    assertEquals(await test.ctx.db.selectFrom("oauth_flows").selectAll().execute(), []);
});

Deno.test("with PKCE, the verifier must match the challenge", async () => {
    await using test = await open();
    const verifier = "v".repeat(43);
    const challenge = await hashToken(verifier);

    const refused = [
        await test.exchange(await test.allowedCode(challenge), { code_verifier: "w".repeat(43) }),
        await test.exchange(await test.allowedCode(challenge)),
        await test.exchange(await test.allowedCode(await hashToken("short")), {
            code_verifier: "short",
        }),
        // Without a challenge, a verifier means one was stripped from the request.
        await test.exchange(await test.allowedCode(), { code_verifier: verifier }),
    ];
    const matched = await test.exchange(await test.allowedCode(challenge), {
        code_verifier: verifier,
    });

    for (const { status, body } of refused) {
        assertEquals([status, body.error], [400, "invalid_grant"]);
    }
    assertEquals(matched.status, 200);
});

Deno.test("a code is only for its app, its redirect URI and ten minutes, and one try", async () => {
    await using test = await open();
    const other = await registerApp(test.ctx, {
        name: "Elk",
        website: null,
        redirectUris: ["https://phanpy.example/back"],
        scopes: ["read", "write"],
    });

    const stolen = await test.allowedCode();
    const misdirected = await test.allowedCode();
    const late = await test.allowedCode();

    const refused = [
        await test.exchange(stolen, {
            client_id: other.app.client_id,
            client_secret: other.clientSecret,
        }),
        await test.exchange(stolen),
        await test.exchange(misdirected, { redirect_uri: "https://phanpy.example/other" }),
        await test.exchange(misdirected),
    ];

    test.clock.advance(10 * 60_000);
    refused.push(await test.exchange(late));

    for (const { status, body } of refused) {
        assertEquals([status, body.error], [400, "invalid_grant"]);
    }
    assertEquals(await test.ctx.db.selectFrom("access_tokens").selectAll().execute(), []);
});

Deno.test("a code grant without a code is an invalid request", async () => {
    await using test = await open();

    const { status, body } = await test.token({
        ...test.credentials,
        grant_type: "authorization_code",
    });

    assertEquals([status, body.error], [400, "invalid_request"]);
});

Deno.test("an app revokes its token, which then stops working, and again is fine", async () => {
    await using test = await open();
    const issued = await test.token({ ...test.credentials, grant_type: "client_credentials" });
    const revoke = { ...test.credentials, token: issued.body.access_token };

    const first = await test.revoke(revoke);
    const again = await test.revoke(revoke);

    assertEquals([first.status, first.body], [200, {}]);
    assertEquals([again.status, again.body], [200, {}]);
    assertEquals(await test.ctx.db.selectFrom("access_tokens").selectAll().execute(), []);
});

Deno.test("only the app a token was issued to may revoke it", async () => {
    await using test = await open();
    const issued = await test.token({ ...test.credentials, grant_type: "client_credentials" });
    const token = issued.body.access_token;
    const other = await registerApp(test.ctx, {
        name: "Elk",
        website: null,
        redirectUris: ["https://elk.example/back"],
        scopes: ["read"],
    });

    const refused = [
        await test.revoke({
            client_id: other.app.client_id,
            client_secret: other.clientSecret,
            token,
        }),
        await test.revoke({ client_id: test.app.client_id, client_secret: "wrong", token }),
        await test.revoke({ token }),
        await test.revoke(test.credentials),
    ];

    for (const { status, body } of refused) {
        assertEquals([status, body.error], [403, "unauthorized_client"]);
    }
    assertEquals((await test.ctx.db.selectFrom("access_tokens").selectAll().execute()).length, 1);
});
