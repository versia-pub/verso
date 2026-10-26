import { assertEquals } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { createLocalAccount } from "../accounts/testing.ts";
import { enqueue } from "../jobs/job_queries.ts";
import { drain } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { createNote } from "../notes/testing.ts";
import { registry } from "../registry.ts";
import { createTestContext } from "../testing/context.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork, type Network } from "../testing/network.ts";
import { messageHandler, MessageJob, messageQueue } from "./messaging.ts";

/** a.test, and the messages it logs, until disposed. */
const open = async () => {
    const network = await createNetwork(["a.test"]);
    const logged: LogRecord[] = [];
    await configure({
        reset: true,
        sinks: { buffer: (record) => logged.push(record) },
        loggers: [
            { category: ["verso", "federation", "messaging"], sinks: ["buffer"] },
            { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
        ],
    });

    /** Sends a.test `body`, unsigned, as `type`. */
    const send = async (body: string, type = "text/plain") =>
        (await network.transport(
            new Request("https://a.test/.versia/v0.6/messaging", {
                method: "POST",
                body,
                headers: { "content-type": type },
            }),
        )).status;

    /** The messages a.test has logged. */
    const messages = () => logged.map((record) => record.properties.message);

    return {
        send,
        messages,
        [Symbol.asyncDispose]: async () => {
            await reset();
            await network[Symbol.asyncDispose]();
        },
    };
};

Deno.test("another instance's message is logged, cut if it is long", async () => {
    await using test = await open();

    assertEquals(await test.send("The User alice failed: username is too long"), 200);
    assertEquals(await test.send("x".repeat(5000)), 200);

    assertEquals(test.messages(), [
        "The User alice failed: username is too long",
        `${"x".repeat(4096)}…`,
    ]);
});

Deno.test("a message must be plain text, and say something", async () => {
    await using test = await open();

    assertEquals(await test.send(JSON.stringify({ message: "Hi" }), "application/json"), 415);
    assertEquals(await test.send(" \n"), 422);
    assertEquals(test.messages(), []);
});

Deno.test("Verso says it takes instance messages", () => {
    assertEquals(registry.extensions.includes("pub.versia:instance_messaging"), true);
});

/** A Like that only d.test may send, as its author is there. */
const like = (created_at = "2026-01-01T00:00:00Z") => ({
    type: "pub.versia:likes/Like",
    id: "l1",
    created_at,
    author: "d.test:bob",
    liked: "a.test:n1",
});

/** The messages a.test sent, by where to. */
const messagesSent = async (network: Network) =>
    await Promise.all(
        network.transport.sent
            .filter((request) => new URL(request.url).pathname === "/.versia/v0.6/messaging")
            .map(async (request) => [
                request.url,
                request.headers.get("content-type"),
                request.headers.has("versia-signature"),
                await request.text(),
            ]),
    );

Deno.test("an instance that takes messages is told why Verso gave up on what it sent, once", async () => {
    await using network = await createNetwork(["a.test"]);
    const c = await addEvilInstance(network, "c.test", ["pub.versia:instance_messaging"]);

    // Sent again, the same mistake is explained once.
    for (const created_at of ["2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z"]) {
        await c.send("https://a.test/.versia/v0.6/inbox", { body: like(created_at) });
        await network.drain();
    }

    assertEquals(await messagesSent(network), [[
        "https://c.test/.versia/v0.6/messaging",
        "text/plain; charset=utf-8",
        false,
        "a.test gave up on the pub.versia:likes/Like l1 you sent its inbox: c.test may not send " +
        "this pub.versia:likes/Like, which only d.test may",
    ]]);
});

Deno.test("what fails for now, and is tried again, isn't explained", async () => {
    await using network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const c = await addEvilInstance(network, "c.test", ["pub.versia:instance_messaging"]);
    const alice = await createLocalAccount(a, "alice");
    const note = await createNote(a, alice);

    // Its author can't be fetched while c.test is down.
    await c.send("https://a.test/.versia/v0.6/inbox", {
        body: { ...like(), author: "bob", liked: `a.test:${note.id}` },
    });
    network.transport.down.add("c.test");
    await network.drain();

    assertEquals(await messagesSent(network), []);
});

Deno.test("an instance that doesn't take messages isn't sent any", async () => {
    await using network = await createNetwork(["a.test"]);
    const d = await addEvilInstance(network, "d.test");

    await d.send("https://a.test/.versia/v0.6/inbox", {
        body: { ...like(), author: "e.test:bob" },
    });
    await network.drain();

    assertEquals(await messagesSent(network), []);
});

Deno.test("a message is given up on if its instance refuses it, retried if it fails, and dropped if it is blocked", async () => {
    await using test = await createTestContext();
    const queues = { [messageQueue]: { handler: messageHandler, concurrency: 1 } };
    const answers: Record<string, number> = { "b.test": 404, "c.test": 500, "d.test": 200 };
    for (const [domain, status] of Object.entries(answers)) {
        test.transport.servers.set(domain, () => new Response(null, { status }));
    }

    /** Sends a message to `domain` once, and says what became of it. */
    const send = async (domain: string, ctx: Context = test.ctx) => {
        const payload: MessageJob = { domain, text: "Hi" };
        const id = await enqueue(ctx, { queue: messageQueue, payload, maxAttempts: 3 });
        if (id === undefined) throw new Error("Not queued");
        await drain(ctx, queues);

        const row = await ctx.db.selectFrom("jobs").selectAll().where("id", "=", id)
            .executeTakeFirst();
        return !row ? "done" : row.attempts === row.max_attempts ? "given up" : "retried";
    };

    assertEquals(await send("d.test"), "done");
    assertEquals(await send("b.test"), "given up");
    assertEquals(await send("c.test"), "retried");

    const blocking = {
        ...test.ctx,
        federation: { ...test.ctx.federation, isBlocked: () => Promise.resolve(true) },
    };
    assertEquals(await send("d.test", blocking), "done");
    assertEquals(test.transport.sent.length, 3);
});
