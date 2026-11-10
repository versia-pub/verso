import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { authorOf, byRemovedUser } from "./authors.ts";

Deno.test("a User is by itself, and anything else by its author", () => {
    assertEquals(authorOf({ type: "User", id: "alice", author: "bob" }), "alice");
    assertEquals(authorOf({ type: "Note", id: "1", author: "bob" }), "bob");
});

Deno.test("an entity without a string author is by nobody", () => {
    assertEquals(authorOf({ type: "Note", author: 5 }), undefined);
    assertEquals(authorOf({ type: "User" }), undefined);
    assertEquals(authorOf(null), undefined);
});

Deno.test("only an entity by a local user Verso doesn't have is by a removed user", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createRemoteAccount(test.ctx, "bob", await createInstance(test.ctx, "b.example"));
    const by = (author: string) => byRemovedUser(test.ctx, { type: "Note", author });

    assertEquals(await by("alice"), false);
    assertEquals(await by("carol"), true);
    // A remote account's id isn't a local user's.
    assertEquals(await by("bob"), true);
    assertEquals(await by("b.example:carol"), false);
    assertEquals(await byRemovedUser(test.ctx, { type: "Note" }), false);
});
