import { assertEquals } from "@std/assert";
import { decode } from "fast-png";
import { z } from "zod";
import { createApp } from "../http/app.ts";
import { memoryRateLimitStore } from "../http/rate_limits.ts";
import { defineRoute } from "../http/route.ts";
import { createTestContext } from "../kernel/testing.ts";
import { accountRoutes } from "./routes.ts";

const ping = defineRoute({
    method: "GET",
    path: "/api/v1/ping",
    summary: "Answers anyone",
    responses: { 200: z.object({}) },
    handler: () => Promise.resolve({ status: 200, body: {} }),
});

const open = async () => {
    const test = await createTestContext();
    const app = createApp(test.ctx, [...accountRoutes, ping], {
        checkResponses: true,
        rateLimits: {
            store: memoryRateLimitStore(test.clock),
            policy: { limit: 2, windowSeconds: 60 },
        },
    });

    return { ...test, app };
};

Deno.test("an account's default pictures are PNGs anyone may cache for a day", async () => {
    await using test = await open();

    for (const [picture, size] of [["avatar", [420, 420]], ["header", [1500, 500]]] as const) {
        const response = await test.app.request(`/accounts/019a/${picture}.png`);
        const image = decode(new Uint8Array(await response.arrayBuffer()), { checkCrc: true });

        assertEquals(response.status, 200, picture);
        assertEquals(response.headers.get("content-type"), "image/png", picture);
        assertEquals(response.headers.get("cache-control"), "public, max-age=86400", picture);
        assertEquals<readonly number[]>([image.width, image.height], size, picture);
    }
});

Deno.test("an id that can't be an account's is refused", async () => {
    await using test = await open();
    const response = await test.app.request("/accounts/a.b/avatar.png");
    await response.body?.cancel();

    assertEquals(response.status, 422);
    assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("pictures aren't rate limited, unlike the API", async () => {
    await using test = await open();
    const status = async (path: string) => {
        const response = await test.app.request(path);
        await response.body?.cancel();
        return response.status;
    };

    for (let i = 0; i < 3; i++) assertEquals(await status("/accounts/019a/avatar.png"), 200);
    for (let i = 0; i < 2; i++) assertEquals(await status("/api/v1/ping"), 200);
    assertEquals(await status("/api/v1/ping"), 429);
});
