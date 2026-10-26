import { assertEquals } from "@std/assert";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
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

Deno.test("a picture that couldn't be drawn is drawn again next time", async () => {
    await using test = await createTestContext();
    let fails = 1;
    const draw = (seed: string) =>
        fails-- > 0
            ? Promise.reject(new Error("Out of memory"))
            : Promise.resolve(new TextEncoder().encode(`avatar of ${seed}`));
    const app = createTestApp(test.ctx, pictureRoutes({ avatar: draw, header: draw }));
    await createLocalAccount(test.ctx, "alice");

    const first = await app.request("/accounts/alice/avatar.png");
    await first.body?.cancel();
    const second = await app.request("/accounts/alice/avatar.png");

    assertEquals([first.status, second.status, await second.text()], [
        500,
        200,
        "avatar of alice",
    ]);
});
