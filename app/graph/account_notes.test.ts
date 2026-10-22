import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { accountNotesOn } from "./account_note_queries.ts";
import { noteAccount } from "./account_notes.ts";

Deno.test("an account notes about others, changes it, and clears it, each to itself", async () => {
    await using test = await createTestContext();
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);

    assertEquals(await noteAccount(test.ctx, "alice", "bob", "Met at the meetup"), true);
    assertEquals(await noteAccount(test.ctx, "alice", "carol", "Owes me lunch"), true);
    assertEquals(await noteAccount(test.ctx, "alice", "alice", "Me"), true);
    await noteAccount(test.ctx, "bob", "carol", "Bob's own");
    assertEquals(
        await accountNotesOn(test.ctx, "alice", ["alice", "bob", "carol"]),
        new Map([["alice", "Me"], ["bob", "Met at the meetup"], ["carol", "Owes me lunch"]]),
    );

    await noteAccount(test.ctx, "alice", "bob", "Changed");
    await noteAccount(test.ctx, "alice", "carol", "");
    assertEquals(
        await accountNotesOn(test.ctx, "alice", ["bob", "carol"]),
        new Map([["bob", "Changed"]]),
    );
    assertEquals(
        await accountNotesOn(test.ctx, "bob", ["carol"]),
        new Map([["carol", "Bob's own"]]),
    );

    assertEquals(await noteAccount(test.ctx, "alice", "missing", "Hi"), false);
    assertEquals(await accountNotesOn(test.ctx, "alice", ["missing"]), new Map());
});
