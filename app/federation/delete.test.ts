import { assertEquals, assertStringIncludes } from "@std/assert";
import { v0_7 } from "@versia/protocol";
import { findNote } from "../notes/note_queries.ts";
import { createNote } from "../notes/testing.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { deleteEntity as localDelete } from "./delete.ts";
import { deleteEntity, userEntity } from "./testing.ts";

const inbox = "https://a.test/.versia/v0.7/inbox";

const user = (id: string) =>
    userEntity(id, {
        avatar: { url: `https://pictures.example/${id}.png`, media_type: "image/png" },
    });

/** a.test, with alice on evil.test and bob on other.test already stored. */
const open = async () => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const evil = await addEvilInstance(network, "evil.test");
    const other = await addEvilInstance(network, "other.test");

    // a.test fetches them, since it doesn't accept users sent unsolicited.
    for (
        const [instance, host, id] of [[evil, "evil.test", "alice"], [
            other,
            "other.test",
            "bob",
        ]] as const
    ) {
        instance.serve(`/.versia/v0.7/entities/User/${id}`, user(id));
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

    /** Sends a Delete from evil.test without running it, and returns the inbox's status. */
    const status = async (body: unknown) => (await evil.send(inbox, { body })).status;

    /** evil.test's alice's status `remoteId`, as a.test stores it, added now, with `more`. */
    const addNote = async (remoteId: string, more: { reblog_of_id?: string } = {}) => {
        const account = await a.db.selectFrom("accounts").select(["id", "instance_id"])
            .where("username", "=", "alice").executeTakeFirstOrThrow();

        return await createNote(a, account.id, {
            instance_id: account.instance_id,
            remote_id: remoteId,
            ...more,
        });
    };

    const usernames = async () =>
        (await a.db.selectFrom("accounts").select("username").orderBy("username").execute())
            .map((row) => row.username);
    const pictures = async () => (await a.db.selectFrom("media").select("url").execute()).length;

    return {
        a,
        send,
        status,
        addNote,
        usernames,
        pictures,
        [Symbol.asyncDispose]: () => network[Symbol.asyncDispose](),
    };
};

Deno.test("an instance can delete its own users, with their pictures", async () => {
    await using test = await open();

    assertEquals(await test.usernames(), ["alice", "bob"]);
    assertEquals(await test.pictures(), 2);

    assertEquals(await test.send(deleteEntity("evil.test:alice")), undefined);
    assertEquals(await test.usernames(), ["bob"]);
    assertEquals(await test.pictures(), 1);

    // A Delete by its author is the same as one deleting a user that Verso doesn't have.
    assertEquals(
        await test.send(deleteEntity("evil.test:alice", { author: "evil.test:alice" })),
        undefined,
    );
});

Deno.test("an instance can't delete another instance's users", async () => {
    await using test = await open();

    assertStringIncludes(
        await test.send(deleteEntity("other.test:bob")) ?? "",
        "evil.test may not delete other.test:bob",
    );
    assertStringIncludes(
        await test.send(deleteEntity("other.test:bob", { author: "other.test:bob" })) ?? "",
        "evil.test may not send this Delete, which only other.test may",
    );
    assertEquals(await test.usernames(), ["alice", "bob"]);
});

Deno.test("a Delete of a type that can't be deleted is given up on", async () => {
    await using test = await open();

    assertStringIncludes(
        await test.send({ ...deleteEntity("evil.test:alice"), deleted_type: "Subscribe" }) ?? "",
        "A Subscribe can't be deleted",
    );
    // Verso stores votes, but a Delete can't withdraw one yet.
    assertStringIncludes(
        await test.send(
            deleteEntity("evil.test:alice", { deleted_type: "pub.versia:polls/Vote" }),
        ) ??
            "",
        "A pub.versia:polls/Vote can't be deleted",
    );
    assertEquals(await test.usernames(), ["alice", "bob"]);
});

Deno.test("a Delete of another instance's user doesn't remove the sender's user's statuses", async () => {
    await using test = await open();
    const note = await test.addNote("n1");

    // evil.test has an alice too, whose statuses would go before the Delete is refused.
    const error = await test.send(deleteEntity("other.test:alice"));

    assertStringIncludes(error ?? "", "evil.test may not delete other.test:alice");
    assertEquals((await findNote(test.a, note.id))?.id, note.id);
});

Deno.test("a Delete with a bare deleted or author id is refused at the inbox", async () => {
    await using test = await open();

    assertEquals(await test.status(deleteEntity("alice")), 422);
    assertEquals(
        await test.status(deleteEntity("evil.test:alice", { author: "alice" })),
        422,
    );

    const jobs = await test.a.db.selectFrom("jobs").select("id").where("queue", "=", "inbox")
        .execute();
    assertEquals(jobs, []);
    assertEquals(await test.usernames(), ["alice", "bob"]);
});

Deno.test("a local Delete names its author and what it deletes with full references", async () => {
    await using test = await open();

    const entity = localDelete(test.a, "alice", "pub.versia:social/Note", "n1");

    assertEquals(entity, {
        type: "Delete",
        created_at: test.a.clock.now().toISOString(),
        author: "a.test:alice",
        deleted_type: "pub.versia:social/Note",
        deleted: "a.test:n1",
    });
    assertEquals(v0_7.Delete.safeParse(entity).success, true);
});

Deno.test("a Delete of a remote note as another type deletes nothing and is dropped", async () => {
    await using test = await open();
    const note = await test.addNote("n1");

    for (
        const type of [
            "pub.versia:likes/Like",
            "pub.versia:likes/Dislike",
            "pub.versia:share/Share",
            "pub.versia:reactions/Reaction",
        ]
    ) {
        const error = await test.send(deleteEntity("evil.test:n1", { deleted_type: type }));

        assertStringIncludes(
            error ?? "",
            `evil.test:n1 is a pub.versia:social/Note, not a ${type}`,
        );
    }

    assertEquals((await findNote(test.a, note.id))?.id, note.id);
});

Deno.test("a Delete of a note as a user, or of a user as a note, deletes nothing", async () => {
    await using test = await open();
    const note = await test.addNote("n1");

    assertStringIncludes(
        await test.send(deleteEntity("evil.test:n1")) ?? "",
        "evil.test:n1 is a pub.versia:social/Note, not a User",
    );
    assertStringIncludes(
        await test.send(
            deleteEntity("evil.test:alice", { deleted_type: "pub.versia:social/Note" }),
        ) ??
            "",
        "evil.test:alice is a User, not a pub.versia:social/Note",
    );

    // The user's statuses are removed before the user is, so they would be gone if it had run.
    assertEquals((await findNote(test.a, note.id))?.id, note.id);
    assertEquals(await test.usernames(), ["alice", "bob"]);
});

Deno.test("a Delete of a remote boost as a note deletes nothing and is dropped", async () => {
    await using test = await open();
    const note = await test.addNote("n1");
    const boost = await test.addNote("s1", { reblog_of_id: note.id });

    const error = await test.send(
        deleteEntity("evil.test:s1", { deleted_type: "pub.versia:social/Note" }),
    );

    assertStringIncludes(error ?? "", "evil.test:s1 is a pub.versia:share/Share, not a");
    assertEquals((await findNote(test.a, boost.id))?.id, boost.id);
});

Deno.test("a Delete of a remote note as a note deletes it", async () => {
    await using test = await open();
    const note = await test.addNote("n1");

    const error = await test.send(
        deleteEntity("evil.test:n1", { deleted_type: "pub.versia:social/Note" }),
    );

    assertEquals(error, undefined);
    assertEquals(await findNote(test.a, note.id), undefined);
    assertEquals(await test.usernames(), ["alice", "bob"]);
});

Deno.test("a Delete of an entity Verso doesn't have is accepted and changes nothing", async () => {
    await using test = await open();
    const note = await test.addNote("n1");

    for (const type of ["User", "pub.versia:social/Note", "pub.versia:likes/Like"]) {
        assertEquals(
            await test.send(deleteEntity("evil.test:ghost", { deleted_type: type })),
            undefined,
        );
    }

    assertEquals((await findNote(test.a, note.id))?.id, note.id);
    assertEquals(await test.usernames(), ["alice", "bob"]);
});
