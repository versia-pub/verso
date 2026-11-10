/**
 * Deleting local accounts between complete instances: every instance that knows the user deletes
 * them, with their statuses, whether or not it follows them.
 * @module
 */
import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { follow } from "../graph/follows.ts";
import { postNote } from "../notes/notes.ts";
import { createNetwork, type Instance } from "../testing/network.ts";
import { deleteLocalAccount } from "./account_deletions.ts";

/** alice on a.test, bob on b.test, who follows her, and carol on c.test, who only looked her up. */
const open = async () => {
    const network = await createNetwork(["a.test", "b.test", "c.test"]);
    const a = network.instances["a.test"];
    const b = network.instances["b.test"];
    const c = network.instances["c.test"];
    await createLocalAccount(a.ctx, "alice");
    await createLocalAccount(b.ctx, "bob");
    await createLocalAccount(c.ctx, "carol");

    const lookUp = async (instance: Instance, viewer: string) => {
        const lookup = await instance.app.request("/api/v1/accounts/lookup?acct=alice@a.test", {
            headers: { authorization: `Bearer ${await tokenFor(instance.ctx, viewer)}` },
        });
        return (await lookup.json()).id as string;
    };
    await follow(b.ctx, "bob", await lookUp(b, "bob"));
    await lookUp(c, "carol");
    await network.drain();

    return Object.assign(network, { a, b, c });
};

/** The usernames of the users `instance` has from other instances. */
const remoteUsers = async (instance: Instance) =>
    (await instance.ctx.db.selectFrom("accounts").select("username")
        .where("instance_id", "is not", null).orderBy("username").execute())
        .map((row) => row.username);

/** The text of the statuses `instance` has from other instances. */
const remoteStatuses = async (instance: Instance) =>
    (await instance.ctx.db.selectFrom("notes").select("content")
        .where("instance_id", "is not", null).execute()).map((row) => row.content);

for (const tombstone of [true, false]) {
    Deno.test(`a deleted user is deleted by every instance that knows them (tombstone: ${tombstone})`, async () => {
        await using network = await open();
        const { a, b, c } = network;
        await postNote(a.ctx, "alice", { text: "Hi", format: "text/plain", spoilerText: "" });
        await network.drain();
        assertEquals(await remoteStatuses(b), ["Hi"]);
        assertEquals([await remoteUsers(b), await remoteUsers(c)], [["alice"], ["alice"]]);

        await deleteLocalAccount(a.ctx, "alice", { tombstone });
        await network.drain();

        assertEquals([await remoteUsers(b), await remoteUsers(c)], [[], []]);
        assertEquals(await remoteStatuses(b), []);
    });
}
