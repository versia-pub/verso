import { assertEquals } from "@std/assert";
import { isUniqueViolation } from "./errors.ts";

Deno.test("Postgres and SQLite unique violations are recognised", () => {
    assertEquals(
        isUniqueViolation(Object.assign(new Error("duplicate key"), { code: "23505" })),
        true,
    );
    assertEquals(isUniqueViolation(new Error("UNIQUE constraint failed: accounts.username")), true);
});

Deno.test("other errors, and things that aren't errors, are not unique violations", () => {
    assertEquals(
        isUniqueViolation(Object.assign(new Error("null value"), { code: "23502" })),
        false,
    );
    assertEquals(
        isUniqueViolation(new Error("NOT NULL constraint failed: accounts.username")),
        false,
    );
    assertEquals(isUniqueViolation(new Error("a UNIQUE constraint failed: x")), false);
    assertEquals(isUniqueViolation({ code: "23505" }), false);
    assertEquals(isUniqueViolation("UNIQUE constraint failed: x"), false);
});
