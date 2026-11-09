/**
 * Suspensions between complete instances: a suspended local user is no longer served nor sent, and
 * what a suspended remote user's instance sends is dropped.
 * @module
 */
import { assertEquals } from "@std/assert";
import { updateProfile } from "../accounts/profile.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { fetchSigned } from "../federation/request.ts";
import { follow, rejectFollow, unfollow } from "../graph/follows.ts";
import { postNote } from "../notes/notes.ts";
import { createNetwork, type Instance } from "../testing/network.ts";
import { removeStatus } from "./statuses.ts";
import { suspend, unsuspend } from "./suspensions.ts";

/** alice on a.test, and bob and carol on b.test, where alice is looked up. */
const open = async () => {
    const network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    const b = network.instances["b.test"];
    await createLocalAccount(a.ctx, "alice");
    for (const id of ["bob", "carol"]) await createLocalAccount(b.ctx, id);

    const lookup = await b.app.request("/api/v1/accounts/lookup?acct=alice@a.test", {
        headers: { authorization: `Bearer ${await tokenFor(b.ctx, "bob")}` },
    });
    const aliceOnB: string = (await lookup.json()).id;

    return Object.assign(network, { a, b, aliceOnB });
};

/** The status of fetching `path` from `to` as `from`. */
const fetched = async (from: Instance, to: Instance, path: string) =>
    (await fetchSigned(from.ctx, new URL(path, to.ctx.urls.origin))).status;

/** The ids of the followers `instance` has of the account `id`. */
const followersOf = async (instance: Instance, id: string) =>
    (await instance.ctx.db.selectFrom("follows").select("follower_id")
        .where("followee_id", "=", id).orderBy("follower_id").execute())
        .map((row) => row.follower_id);

/** The id `instance` has for the remote user `username`. */
const remoteIdOn = async (instance: Instance, username: string) =>
    (await instance.ctx.db.selectFrom("accounts").select("id").where("username", "=", username)
        .where("instance_id", "is not", null).executeTakeFirstOrThrow()).id;

/** The text of the statuses `instance` has from other instances. */
const remoteStatuses = async (instance: Instance) =>
    (await instance.ctx.db.selectFrom("notes").select("content")
        .where("instance_id", "is not", null).execute()).map((row) => row.content);

Deno.test("a suspended local user isn't served, nor followed, and only their deletions are sent", async () => {
    await using network = await open();
    const { a, b, aliceOnB } = network;
    await follow(b.ctx, "bob", aliceOnB);
    await network.drain();
    const note = await postNote(a.ctx, "alice", {
        text: "Hi",
        format: "text/plain",
        spoilerText: "",
    });
    await network.drain();
    assertEquals(await remoteStatuses(b), ["Hi"]);

    await suspend(a.ctx, "alice");

    for (
        const path of [
            "/entities/User/alice",
            "/entities/User/alice/collections/followers",
            `/entities/Note/${note?.id}`,
            `/entities/Note/${note?.id}/collections/replies`,
        ]
    ) {
        assertEquals(await fetched(b, a, `/.versia/v0.6${path}`), 404, path);
    }
    const finger = await a.app.request("/.well-known/webfinger?resource=acct:alice@a.test");
    assertEquals(finger.status, 404);

    // Neither sent, nor a follow accepted.
    await updateProfile(a.ctx, "alice", { displayName: "Alice" });
    await follow(b.ctx, "carol", aliceOnB);
    await network.drain();
    assertEquals(
        (await b.ctx.db.selectFrom("accounts").select("display_name").where("id", "=", aliceOnB)
            .executeTakeFirstOrThrow()).display_name,
        "",
    );
    assertEquals(await followersOf(a, "alice"), [await remoteIdOn(a, "bob")]);

    await removeStatus(a.ctx, note?.id ?? "");
    await network.drain();
    assertEquals(await remoteStatuses(b), []);

    await unsuspend(a.ctx, "alice");
    assertEquals(await fetched(b, a, "/.versia/v0.6/entities/User/alice"), 200);
});

Deno.test("a suspended remote user's instance can only delete, change their profile, and end follows", async () => {
    await using network = await open();
    const { a, b, aliceOnB } = network;
    await follow(b.ctx, "bob", aliceOnB);
    await network.drain();
    const bobOnA = await remoteIdOn(a, "bob");
    await follow(a.ctx, "alice", bobOnA);
    await network.drain();
    await postNote(b.ctx, "bob", { text: "Before", format: "text/plain", spoilerText: "" });
    await network.drain();

    await suspend(a.ctx, bobOnA);
    await postNote(b.ctx, "bob", { text: "During", format: "text/plain", spoilerText: "" });
    await network.drain();
    // Kept, though not taken further.
    assertEquals(await remoteStatuses(a), ["Before"]);
    assertEquals(await followersOf(a, "alice"), [bobOnA]);

    await updateProfile(b.ctx, "bob", { displayName: "Bob" });
    await unfollow(b.ctx, "bob", aliceOnB);
    await network.drain();
    assertEquals(
        (await a.ctx.db.selectFrom("accounts").select("display_name").where("id", "=", bobOnA)
            .executeTakeFirstOrThrow()).display_name,
        "Bob",
    );
    assertEquals(await followersOf(a, "alice"), []);

    // A follow is dropped, and a deletion applied. The clock moves on, or the Follow would be the
    // same as the first, which a.test already applied.
    network.clock.advance(60_000);
    await follow(b.ctx, "bob", aliceOnB);
    const [kept] = await a.ctx.db.selectFrom("notes").select("remote_id")
        .where("instance_id", "is not", null).execute();
    await removeStatus(b.ctx, kept.remote_id ?? "");
    await network.drain();
    assertEquals(await followersOf(a, "alice"), []);
    assertEquals(await remoteStatuses(a), []);

    await rejectFollow(b.ctx, aliceOnB, "bob");
    await network.drain();
    assertEquals(await followersOf(a, bobOnA), []);
});
