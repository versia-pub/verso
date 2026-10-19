import { assertEquals, assertStringIncludes } from "@std/assert";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";

const inbox = "https://a.test/.versia/v0.6/inbox";

const user = (id: string) => ({
    type: "User",
    id,
    created_at: "2026-10-18T12:00:00Z",
    username: id,
    fields: [],
    avatar: { "image/png": { content: `https://pictures.example/${id}.png`, remote: true } },
    manually_approves_followers: false,
    indexable: true,
});

const deletion = (deleted: string, more: Record<string, string> = {}) => ({
    type: "Delete",
    created_at: "2026-10-18T12:00:00Z",
    deleted_type: "User",
    deleted,
    ...more,
});

/** a.test, knowing alice on evil.test and bob on other.test. */
const open = async () => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const evil = await addEvilInstance(network, "evil.test");
    const other = await addEvilInstance(network, "other.test");

    // a.test fetches them, since it doesn't take users sent unasked.
    for (
        const [instance, host, id] of [[evil, "evil.test", "alice"], [
            other,
            "other.test",
            "bob",
        ]] as const
    ) {
        instance.serve(`/.versia/v0.6/entities/User/${id}`, user(id));
        await a.federation.resolve(a, { host, id }, "User");
    }

    /** Sends a Delete from evil.test, runs it, and returns why it was given up on, if it was. */
    const send = async (body: unknown) => {
        // So its job is the latest.
        network.clock.advance(1000);
        await evil.send(inbox, { body });
        await network.drain();

        const job = await a.db.selectFrom("jobs").select(["attempts", "max_attempts", "last_error"])
            .where("queue", "=", "inbox").orderBy("created_at", "desc").executeTakeFirstOrThrow();
        return job.attempts === job.max_attempts ? job.last_error ?? "" : undefined;
    };

    const usernames = async () =>
        (await a.db.selectFrom("accounts").select("username").orderBy("username").execute())
            .map((row) => row.username);
    const pictures = async () => (await a.db.selectFrom("media").select("url").execute()).length;

    return {
        send,
        usernames,
        pictures,
        [Symbol.asyncDispose]: () => network[Symbol.asyncDispose](),
    };
};

Deno.test("an instance can delete its own users, with their pictures", async () => {
    await using test = await open();
    assertEquals(await test.usernames(), ["alice", "bob"]);
    assertEquals(await test.pictures(), 2);

    assertEquals(await test.send(deletion("alice")), undefined);
    assertEquals(await test.usernames(), ["bob"]);
    assertEquals(await test.pictures(), 1);

    // By its author, or deleting a user it doesn't have, is the same.
    assertEquals(await test.send(deletion("evil.test:alice", { author: "alice" })), undefined);
});

Deno.test("an instance can't delete another instance's users", async () => {
    await using test = await open();

    assertStringIncludes(
        await test.send(deletion("other.test:bob")) ?? "",
        "evil.test may not delete other.test:bob",
    );
    assertStringIncludes(
        await test.send(deletion("other.test:bob", { author: "other.test:bob" })) ?? "",
        "evil.test may not send this Delete, which only other.test may",
    );
    assertEquals(await test.usernames(), ["alice", "bob"]);
});

Deno.test("a Delete of a type that can't be deleted is given up on", async () => {
    await using test = await open();

    assertStringIncludes(
        await test.send({ ...deletion("alice"), deleted_type: "Note" }) ?? "",
        "A Note can't be deleted",
    );
    assertEquals(await test.usernames(), ["alice", "bob"]);
});
