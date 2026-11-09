import { assertEquals } from "@std/assert";
import { registry } from "./registry.ts";

Deno.test("only entities that can change back to what they were are resendable", () => {
    const resendable = [...registry.types.values()].filter((type) => type.resendable);

    // Every other entity is new when sent, with a time of its own, so its body differs.
    assertEquals(resendable.map((type) => type.type).toSorted(), ["Note", "User"]);
});

Deno.test("every entity other instances fetch says who it is by, so a suspended user's isn't served", () => {
    const fetched = [...registry.types.values()].filter((type) => type.find || type.collections);

    for (const type of fetched) {
        const shape = (type.schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
        assertEquals(type.type === "User" || "author" in shape, true, type.type);
    }
    assertEquals(fetched.map((type) => type.type).toSorted(), [
        "Note",
        "User",
        "pub.versia:likes/Like",
        "pub.versia:reactions/Reaction",
        "pub.versia:share/Share",
    ]);
});
