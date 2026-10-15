import { assertEquals, assertNotEquals } from "@std/assert";
import { createApp } from "../http/app.ts";
import { createTestContext } from "../kernel/testing.ts";
import { authRoutes } from "./routes.ts";
import { hashToken } from "./secrets.ts";

const open = async () => {
    const test = await createTestContext();
    const app = createApp(test.ctx, authRoutes, { checkResponses: true });

    const register = async (body: Record<string, unknown> | URLSearchParams) => {
        const json = !(body instanceof URLSearchParams);
        const response = await app.request("/api/v1/apps", {
            method: "POST",
            body: json ? JSON.stringify(body) : body,
            headers: json ? { "content-type": "application/json" } : {},
        });

        return { status: response.status, body: await response.json() };
    };

    return { ...test, register };
};

Deno.test("an app registers with Mastodon's defaults", async () => {
    await using test = await open();

    const { status, body } = await test.register({
        client_name: "Phanpy",
        redirect_uris: "https://phanpy.example/",
    });

    assertEquals(status, 200);
    assertEquals(body.name, "Phanpy");
    assertEquals(body.website, null);
    assertEquals(body.scopes, ["read"]);
    assertEquals(body.redirect_uris, ["https://phanpy.example/"]);
    assertEquals(body.redirect_uri, "https://phanpy.example/");
    assertEquals(body.client_secret_expires_at, 0);
});

Deno.test("a form registers several redirect URIs and scopes", async () => {
    await using test = await open();
    const form = new URLSearchParams([
        ["client_name", "Tusky"],
        ["redirect_uris[]", "tusky://oauth"],
        ["redirect_uris[]", "urn:ietf:wg:oauth:2.0:oob"],
        ["scopes", " read  write push read "],
        ["website", "https://tusky.example"],
    ]);

    const { body } = await test.register(form);

    assertEquals(body.redirect_uris, ["tusky://oauth", "urn:ietf:wg:oauth:2.0:oob"]);
    assertEquals(body.redirect_uri, "tusky://oauth\nurn:ietf:wg:oauth:2.0:oob");
    assertEquals(body.scopes, ["read", "write", "push"]);
    assertEquals(body.website, "https://tusky.example");
});

Deno.test("only the hash of the client secret is stored", async () => {
    await using test = await open();
    const app = { client_name: "Elk", redirect_uris: "https://elk.example/" };

    const first = (await test.register(app)).body;
    const second = (await test.register(app)).body;
    const stored = await test.ctx.db.selectFrom("apps").selectAll().where("id", "=", first.id)
        .executeTakeFirstOrThrow();

    assertEquals(stored.client_secret_hash, await hashToken(first.client_secret));
    assertEquals(stored.client_id, first.client_id);
    assertNotEquals(first.client_id, second.client_id);
    assertNotEquals(first.client_secret, second.client_secret);
});

Deno.test("invalid registrations are refused with each problem", async () => {
    await using test = await open();

    const refused = async (body: Record<string, unknown>) => {
        const { status, body: error } = await test.register(body);
        assertEquals(status, 422);
        return Object.keys(error.details);
    };

    assertEquals(await refused({}), ["body.client_name", "body.redirect_uris"]);
    assertEquals(
        await refused({
            client_name: "x".repeat(61),
            redirect_uris: ["https://a.example/#token", "/relative", "javascript:alert(1)"],
            scopes: "read admin",
            website: "ftp://a.example",
        }),
        [
            "body.client_name",
            "body.redirect_uris.0",
            "body.redirect_uris.1",
            "body.redirect_uris.2",
            "body.scopes.1",
            "body.website",
        ],
    );
    assertEquals(
        await refused({ client_name: "x", redirect_uris: ["https://a.example/\nhttps://b"] }),
        ["body.redirect_uris.0"],
    );

    // Each fits, but Mastodon limits them joined.
    const long = `https://a.example/${"x".repeat(990)}`;
    assertEquals(await refused({ client_name: "x", redirect_uris: [long, long, long] }), [
        "body.redirect_uris",
    ]);
});
