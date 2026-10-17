import { assertEquals } from "@std/assert";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../kernel/testing.ts";
import { pictureRoutes } from "./picture_routes.ts";
import { createLocalAccount } from "./testing.ts";

Deno.test("an account's pictures are drawn once, and only for accounts that exist", async () => {
    await using test = await createTestContext();
    const drawn: string[] = [];
    const draw = (name: string) => (seed: string) => {
        drawn.push(`${name}:${seed}`);
        return Promise.resolve(new TextEncoder().encode(`${name} of ${seed}`));
    };
    const app = createTestApp(
        test.ctx,
        pictureRoutes({ avatar: draw("avatar"), header: draw("header") }),
    );
    await createLocalAccount(test.ctx, "alice");
    const get = async (path: string) => {
        const response = await app.request(path);
        return { status: response.status, body: await response.text() };
    };

    for (let i = 0; i < 2; i++) {
        assertEquals(await get("/accounts/alice/avatar.png"), {
            status: 200,
            body: "avatar of alice",
        });
        assertEquals(await get("/accounts/alice/header.png"), {
            status: 200,
            body: "header of alice",
        });
    }
    assertEquals((await get("/accounts/nobody/avatar.png")).status, 404);

    assertEquals(drawn, ["avatar:alice", "header:alice"]);
});
