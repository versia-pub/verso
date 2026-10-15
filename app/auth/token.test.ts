import { assertEquals } from "@std/assert";
import { createApp } from "../http/app.ts";
import { createTestContext } from "../kernel/testing.ts";
import { registerApp } from "./apps.ts";
import { authRoutes } from "./routes.ts";
import { hashToken } from "./secrets.ts";

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

    return { ...test, app, credentials, basic, token };
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
