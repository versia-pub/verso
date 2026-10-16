import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { instanceKey } from "../instances/keys.ts";
import { createTestContext } from "../kernel/testing.ts";
import { adminUsage, findAdminCommand, runAdminCommand } from "./cli.ts";

Deno.test("commands are found by their words, and only those", () => {
    assert(findAdminCommand(["keys", "rotate"]));

    for (const words of [[], ["keys"], ["keys", "rotate", "now"], ["toString"], ["constructor"]]) {
        assertEquals(findAdminCommand(words), undefined, words.join(" "));
    }
});

Deno.test("the usage lists every command", () => {
    assert(adminUsage.includes("keys rotate"));
});

Deno.test("rotating the key prints the new public key, and the old key is gone", async () => {
    await using test = await createTestContext();
    const before = await instanceKey(test.ctx);
    test.clock.advance(1000);

    const command = findAdminCommand(["keys", "rotate"]);
    assert(command);
    const printed = JSON.parse(await runAdminCommand(test.ctx, command));

    const keys = await test.ctx.db.selectFrom("instance_keys").select("public_key").execute();
    assertNotEquals(printed.public_key, before.publicKey);
    assertEquals(keys, [{ public_key: printed.public_key }]);
    assertEquals((await instanceKey(test.ctx)).publicKey, printed.public_key);
});
