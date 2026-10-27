import { assertEquals, assertRejects } from "@std/assert";
import { PostgresDialect, sql } from "kysely";
import pg from "pg";
import { z } from "zod";
import { type Channel, publish, subscribe } from "../kernel/pubsub.ts";
import { createTestContext } from "../testing/context.ts";
import { connect, type Database } from "./database.ts";
import { messagesChannel, postgresPubSub } from "./postgres_pubsub.ts";
import { testDatabaseKind, testPostgresUrl } from "./testing.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const said: Channel<string> = { name: "said", schema: z.string() };
const other: Channel<string> = { ...said, name: "other" };

/** Waits until `done` resolves true, or long enough that it won't. */
const until = async (done: () => boolean | Promise<boolean>) => {
    const started = Date.now();
    while (!await done() && Date.now() - started < 5_000) await delay(5);
};

/** A new Postgres database, and a pool connected to it. */
const postgres = async () => {
    const url = await testPostgresUrl();
    if (!url) return undefined;

    return {
        url,
        db: connect<Database>(
            new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
        ),
    };
};

Deno.test({
    name: "on Postgres, every process hears a message once its transaction commits",
    ignore: testDatabaseKind === "pglite" || testDatabaseKind === "sqlite",
    fn: async () => {
        const opened = await postgres();
        if (!opened) return;

        const { url, db } = opened;
        await using sending = postgresPubSub(db, url);
        await using elsewhere = postgresPubSub(db, url);
        await using test = await createTestContext({ db, pubsub: sending });

        const heard: string[] = [];
        const hear = (who: string) => (text: string) =>
            Promise.resolve(void heard.push(`${who}: ${text}`));
        subscribe(test.ctx, said, hear("sender"));
        subscribe({ ...test.ctx, pubsub: elsewhere }, said, hear("elsewhere"));
        subscribe({ ...test.ctx, pubsub: elsewhere }, other, hear("elsewhere, other"));
        assertEquals([await sending.listen(), await elsewhere.listen()], [true, true]);

        await assertRejects(() =>
            test.ctx.transaction(async (tx) => {
                await publish(tx, said, "undone");
                throw new Error("Rolled back");
            })
        );

        // Not messages, though each would be one on any channel.
        for (const payload of ["{", JSON.stringify("hi"), JSON.stringify([1, "hi"])]) {
            await sql`select pg_notify(${messagesChannel}, ${payload})`.execute(db);
        }

        await test.ctx.transaction(async (tx) => {
            await publish(tx, said, "hi");
            await publish(tx, other, "bye");
            await delay(100);
            assertEquals(heard, []);
        });

        await until(() => heard.length >= 3);
        await delay(100);
        assertEquals(heard.toSorted(), ["elsewhere, other: bye", "elsewhere: hi", "sender: hi"]);
    },
});

Deno.test({
    name: "on Postgres, a process listens once it subscribes, and stops once disposed",
    ignore: testDatabaseKind === "pglite" || testDatabaseKind === "sqlite",
    fn: async () => {
        const opened = await postgres();
        if (!opened) return;

        const { url, db } = opened;
        await using test = await createTestContext({ db });
        const listeners = async () => {
            const { rows } = await sql<{ count: number }>`
                select count(*)::int as count from pg_stat_activity
                where datname = current_database() and query = ${`listen ${messagesChannel}`}
            `.execute(db);
            return rows[0]?.count;
        };

        {
            await using pubsub = postgresPubSub(db, url);
            await publish({ ...test.ctx, pubsub }, said, "sent");
            await delay(100);
            assertEquals(await listeners(), 0);

            subscribe({ ...test.ctx, pubsub }, said, () => Promise.resolve());
            await until(async () => await listeners() === 1);
            assertEquals(await listeners(), 1);
        }

        await until(async () => await listeners() === 0);
        assertEquals(await listeners(), 0);
    },
});

Deno.test("when Postgres can't be reached, a process hears nothing", async () => {
    await using test = await createTestContext();
    await using pubsub = postgresPubSub(test.ctx.db, "postgres://verso@127.0.0.1:1/verso");

    assertEquals(await pubsub.listen(), false);
});
