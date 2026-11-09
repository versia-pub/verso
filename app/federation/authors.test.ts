import { assertEquals } from "@std/assert";
import { authorOf } from "./authors.ts";

Deno.test("a User is by itself, and anything else by its author", () => {
    assertEquals(authorOf({ type: "User", id: "alice", author: "bob" }), "alice");
    assertEquals(authorOf({ type: "Note", id: "1", author: "bob" }), "bob");
});

Deno.test("an entity without a string author is by nobody", () => {
    assertEquals(authorOf({ type: "Note", author: 5 }), undefined);
    assertEquals(authorOf({ type: "User" }), undefined);
    assertEquals(authorOf(null), undefined);
});
