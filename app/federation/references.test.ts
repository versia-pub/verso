import { assertEquals } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import { referencesTo } from "./references.ts";

Deno.test("a reference names the entity's instance, and a remote one without its id is left out", async () => {
    await using test = await createTestContext();

    assertEquals(
        referencesTo(test.ctx, [
            { id: "a1", remote_id: null, domain: null },
            { id: "b1", remote_id: "x1", domain: "b.example" },
            { id: "b2", remote_id: null, domain: "b.example" },
        ]),
        [`${test.ctx.urls.domain}:a1`, "b.example:x1"],
    );
});
