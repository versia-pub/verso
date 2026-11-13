import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "../notes/note_queries.ts";
import { createNote } from "../notes/testing.ts";
import { addEvilInstance, type EvilInstance } from "../testing/evil.ts";
import { createNetwork, type Network } from "../testing/network.ts";

/** A user served by b.test. */
export const user = (id: string): Record<string, unknown> => ({
    type: "User",
    id,
    created_at: "2026-01-01T00:00:00Z",
    username: id,
    fields: [],
    manually_approves_followers: false,
    indexable: true,
});

/** bob's Delete of his entity `deleted`, of the type `deleted_type`. */
export const undo = (deleted_type: string, deleted: string): Record<string, unknown> => ({
    type: "Delete",
    created_at: "2026-01-01T00:00:00Z",
    author: "bob",
    deleted_type,
    deleted,
});

/** Why `ctx` gave up on what it was sent, oldest first. */
export const inboxErrors = async (ctx: Context): Promise<string[]> =>
    (await ctx.db.selectFrom("jobs").select("last_error").where("queue", "=", "inbox")
        .where("last_error", "is not", null).orderBy("created_at").execute())
        .map((job) => job.last_error ?? "");

/** The instances of {@link openFederation}. */
export type Federation = AsyncDisposable & {
    readonly network: Network;
    /** a.test, the instance under test. */
    readonly a: Context;
    /** b.test. */
    readonly b: EvilInstance;
    /** The local user alice. */
    readonly alice: string;
    /** alice's status. */
    readonly local: NoteRow;
    /** Has b.test send `entity` to a.test, a second after the last, and a.test receive it. */
    readonly send: (entity: object) => Promise<void>;
    /** Why a.test gave up on what it was sent, oldest first. */
    readonly errors: () => Promise<string[]>;
};

/**
 * a.test, with alice and her status `local`, and b.test, which sends whatever it is told to, and
 * serves `users`.
 */
export const openFederation = async (users: readonly string[]): Promise<Federation> => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    for (const id of users) b.serve(`/.versia/v0.6/entities/User/${id}`, user(id));

    const alice = await createLocalAccount(a, "alice");
    const local = await createNote(a, alice);

    /** Has b.test send `entity` to a.test, a second after the last, and a.test receive it. */
    const send = async (entity: object) => {
        network.clock.advance(1000);
        assertEquals(
            (await b.send("https://a.test/.versia/v0.6/inbox", { body: entity })).status,
            202,
        );
        await network.drain();
    };

    return {
        network,
        a,
        b,
        alice,
        local,
        send,
        errors: () => inboxErrors(a),
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};
