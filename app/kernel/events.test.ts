import { assertEquals, assertRejects } from "@std/assert";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { listBlockedDomains } from "../moderation/domain_block_queries.ts";
import { createTestContext } from "../testing/context.ts";
import type { DomainEvent, Subscriber } from "./context.ts";
import { emit } from "./events.ts";

/** Subscribers that record what they were told, and whether inside a transaction. */
const listening = () => {
    const told: [string, DomainEvent, boolean][] = [];
    const subscriber = (name: string): Subscriber => (ctx, event) => {
        told.push([name, event, ctx.db.isTransaction]);
        return Promise.resolve();
    };

    return { told, subscribers: [subscriber("first"), subscriber("second")] };
};

Deno.test("every subscriber is told of each event in turn, in its transaction", async () => {
    const { told, subscribers } = listening();
    await using test = await createTestContext({ subscribers });
    const event = { type: "Tested" };

    await test.ctx.transaction((tx) => emit(tx, event));

    assertEquals(told, [["first", event, true], ["second", event, true]]);
});

Deno.test("an event can't be emitted outside a transaction", async () => {
    const { told, subscribers } = listening();
    await using test = await createTestContext({ subscribers });

    await assertRejects(
        () => emit(test.ctx, { type: "Tested" }),
        Error,
        "Tested was emitted outside a transaction",
    );
    assertEquals(told, []);
});

Deno.test("a subscriber that fails undoes the change", async () => {
    const failing: Subscriber = () => Promise.reject(new Error("Can't"));
    await using test = await createTestContext({ subscribers: [failing] });

    await assertRejects(() =>
        test.ctx.transaction(async (tx) => {
            await blockDomain(tx, "b.example");
            await emit(tx, { type: "Tested" });
        })
    );

    assertEquals(await listBlockedDomains(test.ctx), []);
});
