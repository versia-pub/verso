import { html } from "@hono/hono/html";
import { assertEquals } from "@std/assert";
import { z } from "zod";
import { createTestContext } from "../testing/context.ts";
import { urlBuilder } from "../kernel/urls.ts";
import { createTestApp } from "../testing/app.ts";
import { layout } from "./page.ts";
import { defineRoute, Page } from "./route.ts";

const thing = defineRoute({
    method: "GET",
    path: "/api/v1/thing",
    summary: "Needs a token",
    auth: { require: "user" },
    responses: { 200: z.object({}) },
    handler: () => Promise.resolve({ status: 200, body: {} }),
});

const login = defineRoute({
    method: "GET",
    path: "/oauth/authorize",
    summary: "A page browsers see",
    responses: { 200: Page },
    handler: () => Promise.resolve({ status: 200, page: layout("Log in", html`<p>Hi</p>`) }),
});

const open = async (origin?: string) => {
    const test = await createTestContext();
    const ctx = origin === undefined
        ? test.ctx
        : { ...test.ctx, urls: urlBuilder("social.example", origin) };

    return { ...test, app: createTestApp(ctx, [thing, login]) };
};

const headersOf = async (response: Response) => {
    await response.body?.cancel();
    return response.headers;
};

Deno.test("API errors carry CORS headers, so web clients can read them", async () => {
    await using test = await open();
    const headers = await headersOf(
        await test.app.request("/api/v1/thing", { headers: { origin: "https://elk.example" } }),
    );

    assertEquals(headers.get("access-control-allow-origin"), "*");
    assertEquals(
        headers.get("access-control-expose-headers"),
        "Link,RateLimit-Limit,RateLimit-Remaining,RateLimit-Reset,Retry-After",
    );
});

Deno.test("a preflight is answered without a token, allowing the headers asked for", async () => {
    await using test = await open();
    const response = await test.app.request("/api/v1/thing", {
        method: "OPTIONS",
        headers: {
            origin: "https://elk.example",
            "access-control-request-method": "PATCH",
            "access-control-request-headers": "authorization,content-type",
        },
    });
    const headers = await headersOf(response);

    assertEquals(response.status, 204);
    assertEquals(headers.get("access-control-allow-methods"), "GET,POST,PUT,PATCH,DELETE");
    assertEquals(headers.get("access-control-allow-headers"), "authorization,content-type");
});

Deno.test("only the token endpoints of /oauth allow other sites", async () => {
    await using test = await open();
    const preflight = async (path: string) =>
        await headersOf(
            await test.app.request(path, {
                method: "OPTIONS",
                headers: { origin: "https://elk.example", "access-control-request-method": "POST" },
            }),
        );

    assertEquals((await preflight("/oauth/token")).get("access-control-allow-methods"), "POST");
    assertEquals((await preflight("/oauth/revoke")).get("access-control-allow-origin"), "*");
    assertEquals((await preflight("/oauth/authorize")).get("access-control-allow-origin"), null);
});

Deno.test("every reply forbids sniffing and framing, and pages keep their own policy", async () => {
    await using test = await open();
    const api = await headersOf(await test.app.request("/api/v1/thing"));
    const page = await headersOf(await test.app.request("/oauth/authorize"));

    assertEquals(api.get("x-content-type-options"), "nosniff");
    assertEquals(api.get("x-frame-options"), "DENY");
    assertEquals(api.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
    assertEquals(api.get("referrer-policy"), "no-referrer");
    assertEquals(
        page.get("content-security-policy"),
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
});

Deno.test("HSTS is only sent when the instance is reached over HTTPS", async () => {
    await using https = await open();
    await using http = await open("http://localhost:8080");

    assertEquals(
        (await headersOf(await https.app.request("/health/live"))).get("strict-transport-security"),
        "max-age=31536000",
    );
    assertEquals(
        (await headersOf(await http.app.request("/health/live"))).get("strict-transport-security"),
        null,
    );
});
