import { assertEquals } from "@std/assert";
import { notBlank } from "./schemas.ts";

Deno.test("notBlank refuses text that is empty or only whitespace", () => {
    const [check] = notBlank("Title");

    assertEquals(check(""), false);
    assertEquals(check("  \n\t"), false);
    assertEquals(check("a"), true);
    assertEquals(check(" a "), true);
});

Deno.test("notBlank names the field in its error", () => {
    assertEquals(notBlank("Title")[1].error, "Title can't be blank");
    assertEquals(notBlank("Keyword")[1].error, "Keyword can't be blank");
});
