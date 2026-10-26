import { assertEquals } from "@std/assert";
import { registry } from "./registry.ts";

Deno.test("only entities that can change back to what they were are resendable", () => {
    const resendable = [...registry.types.values()].filter((type) => type.resendable);

    // Every other entity is new when sent, with a time of its own, so its body differs.
    assertEquals(resendable.map((type) => type.type).toSorted(), ["Note", "User"]);
});
