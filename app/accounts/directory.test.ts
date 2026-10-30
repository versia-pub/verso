import { assertEquals } from "@std/assert";
import { tokenFor } from "../auth/testing.ts";
import { block } from "../graph/blocks.ts";
import { mute } from "../graph/mutes.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { directoryRoutes } from "./directory.ts";
import { createLocalAccount, createRemoteAccount } from "./testing.ts";

/**
 * Accounts created a second apart: alice, who isn't listed, then ann, who posted an hour ago, bea,
 * who never posted, and cat, who posted a minute ago, all listed, and a listed remote account.
 */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, directoryRoutes, { checkResponses: true });

    await createLocalAccount(test.ctx, "alice");
    for (const username of ["ann", "bea", "cat"]) {
        test.clock.advance(1000);
        await createLocalAccount(test.ctx, username);
    }

    const instanceId = await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "remote", instanceId);
    await test.ctx.db.updateTable("accounts")
        .set({ discoverable: true })
        .where("id", "in", ["ann", "bea", "cat", "remote"])
        .execute();

    const now = test.clock.now().getTime();
    for (const [id, ago] of [["ann", 60 * 60_000], ["cat", 60_000]] as const) {
        await test.ctx.db.updateTable("accounts")
            .set({ last_status_at: new Date(now - ago) })
            .where("id", "=", id)
            .execute();
    }

    /** The usernames listed at `path`, as alice sees them, or signed out with `null`. */
    const list = async (path: string, as: string | null = "alice") => {
        const headers: Record<string, string> = {};
        if (as !== null) headers.authorization = `Bearer ${await tokenFor(test.ctx, as)}`;

        const response = await app.request(path, { headers });
        assertEquals(response.status, 200);
        return (await response.json()).map((account: { username: string }) => account.username);
    };

    return { ...test, list };
};

Deno.test("the directory lists local discoverable accounts, active or newest first", async () => {
    await using test = await open();

    assertEquals(await test.list("/api/v1/directory"), ["cat", "ann", "bea"]);
    assertEquals(await test.list("/api/v1/directory?order=new"), ["cat", "bea", "ann"]);
    assertEquals(await test.list("/api/v1/directory?local=true", null), ["cat", "ann", "bea"]);
    assertEquals(await test.list("/api/v1/directory?limit=1&offset=1"), ["ann"]);
});

Deno.test("the directory leaves out who the viewer blocks or mutes, and who blocks them", async () => {
    await using test = await open();
    await block(test.ctx, "alice", "ann");
    await mute(test.ctx, "alice", "bea", { notifications: true, duration: 0 });
    await block(test.ctx, "cat", "alice");

    assertEquals(await test.list("/api/v1/directory"), []);
    assertEquals(await test.list("/api/v1/directory", null), ["cat", "ann", "bea"]);
    assertEquals(await test.list("/api/v1/directory", "bea"), ["cat", "ann", "bea"]);
});
