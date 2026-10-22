import { assertEquals } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { registry } from "../registry.ts";
import { createNetwork } from "../testing/network.ts";

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
