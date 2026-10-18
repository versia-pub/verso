import { assertEquals } from "@std/assert";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";

const inbox = "https://a.test/.versia/v0.6/inbox";

const user = {
    type: "User",
    id: "alice",
    created_at: "2026-10-18T12:00:00Z",
    username: "alice",
    fields: [],
    manually_approves_followers: false,
    indexable: true,
};

const open = async () => {
    const network = await createNetwork(["a.test"]);
    const evil = await addEvilInstance(network, "evil.test");
    const a = network.instances["a.test"].ctx;

    /** What evil.test sends, with the reply's status and body. */
    const send = async (body: unknown, signedBy?: string) => {
        const response = await evil.send(inbox, { method: "POST", body, signedBy });
        const text = await response.text();
        return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
    };

    /** The inbox jobs queued on a.test. */
    const jobs = () =>
        a.db.selectFrom("jobs").select(["payload", "dedupe_key", "keep_until"])
            .where("queue", "=", "inbox").orderBy("created_at").execute();

    return {
        network,
        evil,
        a,
        send,
        jobs,
        [Symbol.asyncDispose]: () => network[Symbol.asyncDispose](),
    };
};

Deno.test("an entity is queued as it was sent, and answered with an empty 202", async () => {
    await using test = await open();
    const body = JSON.stringify(user, null, 2);

    assertEquals(await test.send(body), { status: 202, body: undefined });

    const [job, ...others] = await test.jobs();
    assertEquals(others, []);
    assertEquals(job.payload, {
        signer: "evil.test",
        body,
        received_at: test.network.clock.now().toISOString(),
    });
    assertEquals(job.keep_until, new Date(test.network.clock.now().getTime() + 10 * 60_000));
});

Deno.test("the same body from the same instance is queued once", async () => {
    await using test = await open();
    const other = await addEvilInstance(test.network, "other.test");

    await test.send(user);
    assertEquals((await test.send(user)).status, 202);
    assertEquals((await test.jobs()).length, 1);

    // Another body, or the same one from another instance, isn't the same.
    await test.send({ ...user, username: "alice2" });
    await other.send(inbox, { method: "POST", body: user });
    assertEquals(
        (await test.jobs()).map((job) => job.dedupe_key?.split(":")[1]),
        ["evil.test", "evil.test", "other.test"],
    );
});

Deno.test("a body that isn't Versia JSON is a 400", async () => {
    await using test = await open();

    for (const body of ['{"type": "User", "type": "User"}', '{"type": 1e3}', "{", "[1,"]) {
        assertEquals((await test.send(body)).status, 400, body);
    }
    assertEquals(await test.jobs(), []);
});

Deno.test("an entity of no known type, or not matching its type, is a 422", async () => {
    await using test = await open();
    assertEquals(await test.send({ ...user, type: "Bogus" }), {
        status: 422,
        body: { error: "Validation failed", details: { "body.type": ["Unknown type Bogus"] } },
    });
    assertEquals((await test.send({ id: "x" })).status, 422);
    assertEquals((await test.send([user])).status, 422);

    const { username: _, ...nameless } = user;
    const reply = await test.send({ ...nameless, indexable: "yes" });
    assertEquals(reply.status, 422);
    assertEquals(Object.keys(reply.body.details).toSorted(), ["body.indexable", "body.username"]);

    assertEquals(await test.jobs(), []);
});

Deno.test("an entity of an extension Verso doesn't know is accepted and dropped", async () => {
    await using test = await open();
    const like = { type: "pub.versia:likes/Like", id: "1", created_at: "2026-10-18T12:00:00Z" };

    assertEquals(await test.send(like), { status: 202, body: undefined });
    assertEquals(await test.jobs(), []);
});
