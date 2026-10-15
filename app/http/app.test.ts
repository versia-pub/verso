import { assertEquals } from "@std/assert";
import { createApp } from "./app.ts";

Deno.test("the liveness check answers ok", async () => {
    const response = await createApp().request("/health/live");
    assertEquals(response.status, 200);
    assertEquals(await response.text(), "ok");
});

Deno.test("other paths and methods are not found", async () => {
    const app = createApp();
    assertEquals((await app.request("/nothing")).status, 404);
    assertEquals((await app.request("/health/live", { method: "POST" })).status, 404);
});
