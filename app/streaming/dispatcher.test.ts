import { assertEquals } from "@std/assert";
import type { Context } from "../kernel/context.ts";
import { publish } from "../kernel/pubsub.ts";
import { notified } from "../notifications/notifications.ts";
import { createTestContext } from "../testing/context.ts";
import { dispatcher } from "./dispatcher.ts";
import { statusMessages } from "./statuses.ts";

/** A promise, with what settles it. */
const deferred = () => {
    let resolve = () => {};
    const promise = new Promise<void>((settle) => resolve = settle);
    return { promise, resolve };
};

/** Publishes an update of the status `noteId`. */
const update = (ctx: Context, noteId: string) =>
    publish(ctx, statusMessages, { event: "update", noteId });

Deno.test("messages are handled one at a time, in order, without what published them waiting", async () => {
    await using test = await createTestContext();
    const dispatch = dispatcher(test.ctx);
    const heard: string[] = [];
    const held = deferred();
    dispatch.listen({
        statuses: async (message) => {
            if (message.noteId === "first") await held.promise;
            heard.push(message.noteId);
        },
        notifications: (message) => {
            heard.push(message.notificationId);
            return Promise.resolve();
        },
    });

    await update(test.ctx, "first");
    await publish(test.ctx, notified, { accountId: "alice", notificationId: "second" });
    await update(test.ctx, "third");
    assertEquals(heard, []);

    held.resolve();
    await dispatch.idle();
    assertEquals(heard, ["first", "second", "third"]);
});

Deno.test("a message is handled by every listener at once, and those that fail don't stop the rest", async () => {
    await using test = await createTestContext();
    const dispatch = dispatcher(test.ctx);
    let running = 0;
    let most = 0;
    let heard = 0;
    for (let n = 0; n < 4; n++) {
        dispatch.listen({
            statuses: async () => {
                running++;
                most = Math.max(most, running);
                await new Promise((resolve) => setTimeout(resolve, 1));
                running--;
                if (n % 2 === 0) throw new Error("Failed");
                heard++;
            },
        });
    }

    await update(test.ctx, "n1");
    await dispatch.idle();
    assertEquals([most, heard], [4, 2]);
});

Deno.test("a listener stops hearing messages once it stops listening", async () => {
    await using test = await createTestContext();
    const dispatch = dispatcher(test.ctx);
    const heard: string[] = [];
    const stop = dispatch.listen({
        statuses: (message) => {
            heard.push(message.noteId);
            return Promise.resolve();
        },
    });

    await update(test.ctx, "n1");
    await dispatch.idle();
    stop();
    await update(test.ctx, "n2");
    await dispatch.idle();
    assertEquals(heard, ["n1"]);
});

Deno.test("past 1000 messages waiting, more are dropped until there is room", async () => {
    await using test = await createTestContext();
    const dispatch = dispatcher(test.ctx);
    let heard = 0;
    const held = deferred();
    dispatch.listen({
        statuses: async () => {
            await held.promise;
            heard++;
        },
    });

    for (let n = 0; n < 1001; n++) await update(test.ctx, `n${n}`);
    held.resolve();
    await dispatch.idle();
    await update(test.ctx, "again");
    await dispatch.idle();
    assertEquals(heard, 1001);
});
