import { assertEquals, assertRejects } from "@std/assert";
import { sql } from "kysely";
import { testDatabaseKind } from "../db/testing.ts";
import { createTestContext } from "../kernel/testing.ts";
import type { Issuer } from "../kernel/identity.ts";
import { provision, type Provisioned, usernameFrom } from "./provision.ts";

const issuer: Issuer = {
    name: "Example ID",
    url: "https://id.example",
    username_claim: "preferred_username",
    registration: "open",
};

const open = async () => {
    const test = await createTestContext();

    const usernames = async () =>
        (await test.ctx.db.selectFrom("accounts").select("username").orderBy("username").execute())
            .map((account) => account.username);

    return { ...test, usernames };
};

Deno.test("a first login creates an account, and later logins find it", async () => {
    await using test = await open();

    const first = await provision(test.ctx, issuer, { sub: "1", preferred_username: "alice" });
    const again = await provision(test.ctx, issuer, { sub: "1", preferred_username: "renamed" });

    assertEquals(first.ok && first.created, true);
    assertEquals(again, { ok: true, accountId: first.ok ? first.accountId : "", created: false });
    assertEquals(await test.usernames(), ["alice"]);
});

Deno.test("logins are linked by issuer and subject only", async () => {
    await using test = await open();
    const claims = { sub: "1", preferred_username: "alice", email: "a@example.com" };

    await provision(test.ctx, issuer, claims);
    await provision(test.ctx, { ...issuer, url: "https://other.example" }, claims);
    await provision(test.ctx, issuer, { ...claims, sub: "2" });

    assertEquals(await test.usernames(), ["alice", "alice2", "alice3"]);
});

Deno.test("usernames keep only the allowed characters", () => {
    assertEquals(usernameFrom("Zoë Smith!"), "ZoeSmith");
    assertEquals(usernameFrom("dash-and_underscore"), "dash-and_underscore");
    assertEquals(usernameFrom("日本"), undefined);
    assertEquals(usernameFrom(""), undefined);
    assertEquals(usernameFrom(42), undefined);
});

Deno.test("a taken username, in any case, gets a number", async () => {
    await using test = await open();

    await provision(test.ctx, issuer, { sub: "1", preferred_username: "alice" });
    await provision(test.ctx, issuer, { sub: "2", preferred_username: "Alice" });
    await provision(test.ctx, issuer, { sub: "3", preferred_username: "ALICE" });

    assertEquals(await test.usernames(), ["ALICE3", "Alice2", "alice"]);
});

Deno.test("a long username is cut to 30 characters, with room for its number", async () => {
    await using test = await open();
    const long = "a".repeat(40);

    await provision(test.ctx, issuer, { sub: "1", preferred_username: long });
    await provision(test.ctx, issuer, { sub: "2", preferred_username: long });

    assertEquals(await test.usernames(), ["a".repeat(29) + "2", "a".repeat(30)]);
});

Deno.test({
    name: "a login that another request links meanwhile gets that request's account",
    // Only Postgres runs transactions side by side; PGlite and SQLite take them one at a time.
    ignore: testDatabaseKind === "pglite" || testDatabaseKind === "sqlite",
    fn: async () => {
        await using test = await open();
        let provisioned: Promise<Provisioned> | undefined;

        // The other request links the identity, and doesn't commit until this login waits for it.
        await test.ctx.db.transaction().execute(async (other) => {
            await other.insertInto("accounts")
                .values({
                    id: "first",
                    username: "first",
                    instance_id: null,
                    remote_id: null,
                    created_at: test.clock.now(),
                })
                .execute();
            await other.insertInto("identities")
                .values({
                    issuer: issuer.url,
                    subject: "1",
                    account_id: "first",
                    created_at: test.clock.now(),
                })
                .execute();

            provisioned = provision(test.ctx, issuer, { sub: "1", preferred_username: "alice" });

            const waiting = async () => {
                const { rows } = await sql<{ count: string }>`
                    select count(*) from pg_stat_activity where wait_event_type = 'Lock'
                `.execute(test.ctx.db);
                return rows[0].count !== "0";
            };
            while (!await waiting()) await new Promise((resolve) => setTimeout(resolve, 5));
        });

        assertEquals(await provisioned, { ok: true, accountId: "first", created: false });
        assertEquals(await test.usernames(), ["first"]);
    },
});

Deno.test("without a usable claim, the username is user and a number", async () => {
    await using test = await open();

    await provision(test.ctx, issuer, { sub: "1" });
    await provision(test.ctx, issuer, { sub: "2", preferred_username: "日本" });
    await provision(test.ctx, { ...issuer, username_claim: "nickname" }, {
        sub: "3",
        preferred_username: "alice",
    });

    assertEquals(await test.usernames(), ["user1", "user2", "user3"]);
});

Deno.test("an account on another instance doesn't take a local username", async () => {
    await using test = await open();
    await test.ctx.db.insertInto("accounts")
        .values({
            id: "r",
            username: "alice",
            instance_id: "b",
            remote_id: "1",
            created_at: test.clock.now(),
        })
        .execute();

    await provision(test.ctx, issuer, { sub: "1", preferred_username: "alice" });

    assertEquals(await test.usernames(), ["alice", "alice"]);
});

Deno.test("a remote account is stored once per instance", async () => {
    await using test = await open();
    const remote = (id: string, instance: string, username: string) =>
        test.ctx.db.insertInto("accounts")
            .values({
                id,
                username,
                instance_id: instance,
                remote_id: "1",
                created_at: test.clock.now(),
            })
            .execute();

    await remote("r1", "b", "alice");
    await remote("r2", "c", "alice");

    await assertRejects(() => remote("r3", "b", "renamed"));
});

Deno.test("the registration policy decides who gets a new account", async () => {
    await using test = await open();
    const refused = { ok: false, reason: "registration-closed" } as const;
    const gated = { ...issuer, registration: { claim: "groups", contains: "versia-users" } };

    assertEquals(
        await provision(test.ctx, { ...issuer, registration: "closed" }, { sub: "1" }),
        refused,
    );
    assertEquals(await provision(test.ctx, gated, { sub: "2", groups: ["staff"] }), refused);
    assertEquals(await provision(test.ctx, gated, { sub: "3" }), refused);
    assertEquals(await test.usernames(), []);

    assertEquals(
        (await provision(test.ctx, gated, { sub: "4", groups: ["versia-users"] })).ok,
        true,
    );
    assertEquals((await provision(test.ctx, gated, { sub: "5", groups: "versia-users" })).ok, true);
});

Deno.test("a closed issuer still logs in identities that are already linked", async () => {
    await using test = await open();
    const created = await provision(test.ctx, issuer, { sub: "1" });

    const later = await provision(test.ctx, { ...issuer, registration: "closed" }, { sub: "1" });

    assertEquals(later.ok, true);
    assertEquals(later.ok && created.ok && later.accountId === created.accountId, true);
});

Deno.test("deleting an account deletes its identities, and an identity needs an account", async () => {
    await using test = await open();
    await provision(test.ctx, issuer, { sub: "1" });

    await test.ctx.db.deleteFrom("accounts").execute();

    assertEquals(await test.ctx.db.selectFrom("identities").selectAll().execute(), []);
    await assertRejects(() =>
        test.ctx.db.insertInto("identities")
            .values({
                issuer: issuer.url,
                subject: "2",
                account_id: "missing",
                created_at: test.clock.now(),
            })
            .execute()
    );
});
