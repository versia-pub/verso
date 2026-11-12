import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { authRoutes } from "./routes.ts";
import { tokenFor } from "./testing.ts";

const open = async () => {
    const test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    // An animated avatar, whose still preview is another file.
    await test.ctx.db.insertInto("media")
        .values({
            id: "avatar",
            account_id: "alice",
            instance_id: null,
            url: null,
            media_type: "image/gif",
            sha256: "moving",
            preview_sha256: "still",
            description: null,
            processed_at: test.ctx.clock.now(),
            created_at: test.ctx.clock.now(),
        })
        .execute();
    await test.ctx.db.updateTable("accounts")
        .set({ display_name: "Alice", avatar_id: "avatar" })
        .execute();
    const app = createTestApp(test.ctx, authRoutes, { checkResponses: true });

    const request = async (method: string, token?: string) => {
        const headers: HeadersInit = token ? { authorization: `Bearer ${token}` } : {};
        const response = await app.request("/oauth/userinfo", { method, headers });
        return { status: response.status, body: await response.json() };
    };

    return { ...test, request };
};

Deno.test("a user's OpenID claims name their account, for a GET or a POST", async () => {
    await using test = await open();
    const claims = {
        iss: "https://social.example",
        sub: "https://social.example/.versia/v0.6/entities/User/alice",
        name: "Alice",
        preferred_username: "alice",
        profile: "https://social.example/@alice",
        picture: "https://social.example/media/moving",
    };

    for (const method of ["GET", "POST"]) {
        const token = await tokenFor(test.ctx, "alice", ["profile"]);
        assertEquals(await test.request(method, token), { status: 200, body: claims }, method);
    }
});

Deno.test("OpenID claims need a user's token that may see their profile", async () => {
    await using test = await open();

    assertEquals((await test.request("GET")).status, 401);
    assertEquals(
        (await test.request("GET", await tokenFor(test.ctx, null, ["profile"]))).status,
        422,
    );
    assertEquals(
        (await test.request("GET", await tokenFor(test.ctx, "alice", ["read:statuses"]))).status,
        403,
    );
    assertEquals(
        (await test.request("GET", await tokenFor(test.ctx, "alice", ["read:accounts"]))).status,
        200,
    );
});
