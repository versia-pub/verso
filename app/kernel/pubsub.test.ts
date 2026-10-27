import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import { createTestContext } from "../testing/context.ts";
import { type Channel, publish, subscribe } from "./pubsub.ts";

const said: Channel<{ readonly text: string }> = {
    name: "said",
    schema: z.object({ text: z.string() }),
};

const other: Channel<{ readonly text: string }> = { ...said, name: "other" };

Deno.test("messages are heard by their channel's subscribers once the transaction commits", async () => {
    await using test = await createTestContext();
    const heard: string[] = [];
    subscribe(test.ctx, said, async (message) => {
        // Heard before the transaction resolves, though handling it takes a while.
        await new Promise((resolve) => setTimeout(resolve, 10));
        heard.push(`a: ${message.text}`);
    });
    subscribe(test.ctx, said, (message) => Promise.resolve(void heard.push(`b: ${message.text}`)));
    subscribe(test.ctx, other, (message) => Promise.resolve(void heard.push(`c: ${message.text}`)));

    await assertRejects(() =>
        test.ctx.transaction(async (tx) => {
            await publish(tx, said, { text: "undone" });
            throw new Error("Rolled back");
        })
    );

    await test.ctx.transaction(async (tx) => {
        await publish(tx, said, { text: "hi" });
        assertEquals(heard, []);
    });
    assertEquals(heard, ["b: hi", "a: hi"]);

    await publish(test.ctx, other, { text: "now" });
    assertEquals(heard, ["b: hi", "a: hi", "c: now"]);
});

Deno.test("a subscriber hears nothing once it unsubscribes, and each subscription is its own", async () => {
    await using test = await createTestContext();
    const heard: string[] = [];
    const handler = (message: { readonly text: string }) =>
        Promise.resolve(void heard.push(message.text));

    const first = subscribe(test.ctx, said, handler);
    const second = subscribe(test.ctx, said, handler);
    await publish(test.ctx, said, { text: "twice" });

    first();
    await publish(test.ctx, said, { text: "once" });

    second();
    await publish(test.ctx, said, { text: "never" });
    assertEquals(heard, ["twice", "twice", "once"]);
});

Deno.test("messages that aren't the channel's are skipped, and a failing subscriber fails alone", async () => {
    await using test = await createTestContext();
    const heard: string[] = [];
    subscribe(test.ctx, said, () => Promise.reject(new Error("Failed")));
    subscribe(test.ctx, said, (message) => Promise.resolve(void heard.push(message.text)));

    await test.ctx.pubsub.send("said", JSON.stringify({ text: 1 }));
    await test.ctx.pubsub.send("said", "{");
    await test.ctx.pubsub.send("said", JSON.stringify({ text: "heard" }));

    assertEquals(heard, ["heard"]);
});
