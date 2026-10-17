import { assertEquals, assertRejects } from "@std/assert";
import type { Database } from "../db/database.ts";
import { migrate } from "../db/migrate.ts";
import { migrations } from "../db/migrations/mod.ts";
import { testDatabase } from "../db/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { createInstance } from "./testing.ts";

const remoteAccount = (instanceId: string) => ({
    id: "r",
    username: "alice",
    instance_id: instanceId,
    remote_id: "1",
    created_at: new Date(),
});

Deno.test("an account's instance must exist", async () => {
    await using test = await createTestContext();

    await assertRejects(() =>
        test.ctx.db.insertInto("accounts").values(remoteAccount("missing")).execute()
    );
});

Deno.test("an instance can't be deleted while accounts live on it", async () => {
    await using test = await createTestContext();
    const instance = await createInstance(test.ctx, "b.example");
    await test.ctx.db.insertInto("accounts").values(remoteAccount(instance)).execute();

    await assertRejects(() => test.ctx.db.deleteFrom("instances").execute());
});

Deno.test("each domain is one instance", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");

    await assertRejects(() =>
        test.ctx.db.insertInto("instances")
            .values({
                id: "other",
                domain: "b.example",
                protocol: "versia",
                public_key: null,
                key_fetched_at: null,
                created_at: new Date(),
            })
            .execute()
    );
});

Deno.test("adding instances keeps accounts, their logins and their tokens", async () => {
    await using db = await testDatabase<Database>();
    const before = Object.fromEntries(
        Object.entries(migrations).filter(([name]) => name < "0009"),
    );
    await migrate(db, before);

    const createdAt = new Date("2026-01-01T00:00:00Z");
    await db.insertInto("accounts")
        .values({
            id: "a",
            username: "alice",
            instance_id: null,
            remote_id: null,
            created_at: createdAt,
        })
        .execute();
    await db.insertInto("identities")
        .values({
            issuer: "https://id.example",
            subject: "1",
            account_id: "a",
            created_at: createdAt,
        })
        .execute();
    await db.insertInto("apps")
        .values({
            id: "app",
            name: "App",
            website: null,
            redirect_uris: [],
            scopes: ["read"],
            client_id: "client",
            client_secret_hash: "hash",
            created_at: createdAt,
        })
        .execute();
    await db.insertInto("access_tokens")
        .values({
            id: "t",
            token_hash: "hash",
            app_id: "app",
            account_id: "a",
            scopes: ["read"],
            created_at: createdAt,
        })
        .execute();

    const result = await migrate(db);
    assertEquals(result.ok && result.applied[0], "0009_instances");

    assertEquals(
        await db.selectFrom("accounts")
            .select(["id", "username", "instance_id", "remote_id", "created_at"])
            .execute(),
        [
            {
                id: "a",
                username: "alice",
                instance_id: null,
                remote_id: null,
                created_at: createdAt,
            },
        ],
    );
    assertEquals(await db.selectFrom("identities").select("subject").execute(), [{ subject: "1" }]);
    assertEquals(await db.selectFrom("access_tokens").select("id").execute(), [{ id: "t" }]);

    // The username index came through the rebuild too.
    await assertRejects(() =>
        db.insertInto("accounts")
            .values({
                id: "b",
                username: "ALICE",
                instance_id: null,
                remote_id: null,
                created_at: createdAt,
            })
            .execute()
    );
});
