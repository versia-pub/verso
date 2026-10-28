import { assertEquals } from "@std/assert";
import { sql } from "kysely";
import { updateProfile } from "../accounts/profile.ts";
import { provision } from "../accounts/provision.ts";
import { deleteRemoteAccount, type RemoteAccount, saveRemoteAccount } from "../accounts/remote.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { usesSqlite } from "../db/columns.ts";
import { follow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import type { Issuer } from "../kernel/identity.ts";
import { createTestContext } from "../testing/context.ts";
import { type AccountSearch, indexUnindexedAccounts, searchAccounts } from "./accounts.ts";

const open = async () => {
    const test = await createTestContext();
    await createInstance(test.ctx, "b.example");

    /** The usernames of the accounts `query` finds for `viewerId`, as `search` says. */
    const find = async (
        query: string,
        viewerId: string | null = "alice",
        search: Partial<AccountSearch> = {},
    ) => {
        const found = await searchAccounts(test.ctx, {
            query,
            viewerId,
            resolve: false,
            following: false,
            limit: 40,
            offset: 0,
            ...search,
        });
        return found.map((account) => account.username);
    };

    return { ...test, find };
};

const bob: RemoteAccount = {
    instanceId: "b.example",
    remoteId: "bob",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    profile: {
        username: "bob",
        display_name: "Bobby Tables",
        note: "",
        note_format: "text/plain",
        note_html: "",
        fields: [],
        locked: false,
        indexable: true,
    },
    avatar: null,
    header: null,
    emojis: [],
};

Deno.test("accounts are found as they are created, changed and received, and not once deleted", async () => {
    await using test = await open();
    const issuer: Issuer = {
        name: "Example ID",
        url: "https://id.example",
        username_claim: "preferred_username",
        registration: "open",
        roles: [],
    };

    const claims = { sub: "1", preferred_username: "alice", name: "Zoë" };
    const provisioned = await provision(test.ctx, issuer, claims);
    if (!provisioned.ok) throw new Error("Not provisioned");
    assertEquals(await test.find("alice"), ["alice"]);
    assertEquals(await test.find("zoe"), ["alice"]);

    await updateProfile(test.ctx, provisioned.accountId, { displayName: "Alice Liddell" });
    assertEquals(await test.find("zoe"), []);
    assertEquals(await test.find("lidd"), ["alice"]);

    await saveRemoteAccount(test.ctx, bob);
    assertEquals(await test.find("tables"), ["bob"]);
    // By its domain too.
    assertEquals(await test.find("bob b.exa"), ["bob"]);
    await saveRemoteAccount(test.ctx, { ...bob, profile: { ...bob.profile, display_name: "Rob" } });
    assertEquals(await test.find("tables"), []);
    assertEquals(await test.find("rob"), ["bob"]);

    await deleteRemoteAccount(test.ctx, "b.example", "bob");
    assertEquals(await test.find("rob"), []);
    // Its words went with it, on SQLite too, where they are kept apart.
    const table = usesSqlite(test.ctx.db) ? sql`account_search_text` : sql`account_search`;
    const { rows: [row] } = await sql<{ count: number }>`SELECT count(*) AS count FROM ${table}`
        .execute(test.ctx.db);
    assertEquals(Number(row.count), 1);
});

/**
 * Alice, who follows annie, asked to follow anne on b.example, and is followed by annette, and
 * anna, followed by carol and dave, each indexed as if from before Verso searched accounts.
 */
const openAnns = async () => {
    const test = await open();
    for (const id of ["alice", "anna", "annie", "annette", "carol", "dave"]) {
        await createLocalAccount(test.ctx, id);
    }
    await createRemoteAccount(test.ctx, "anne", "b.example");
    await follow(test.ctx, "alice", "annie");
    await follow(test.ctx, "annette", "alice");
    await follow(test.ctx, "carol", "anna");
    await follow(test.ctx, "dave", "anna");
    // A request, until anne's instance accepts it.
    await follow(test.ctx, "alice", "anne");

    assertEquals(await indexUnindexedAccounts(test.ctx), 7);
    assertEquals(await indexUnindexedAccounts(test.ctx), 0);

    return test;
};

Deno.test("accounts the viewer follows or is followed by come first, then those most followed", async () => {
    await using test = await openAnns();

    assertEquals(await test.find("ann"), ["annie", "annette", "anna", "anne"]);
    assertEquals(await test.find("ann", "carol"), ["anna", "annie", "anne", "annette"]);
    assertEquals(await test.find("ann", "alice", { limit: 2, offset: 1 }), ["annette", "anna"]);
    assertEquals(await test.find("ann", "alice", { following: true }), ["annie"]);
    assertEquals(await test.find("a", "alice", { following: true }), ["annie", "alice"]);
    // Following alice counts as much as being followed by her, so more followers win.
    await follow(test.ctx, "carol", "annette");
    await follow(test.ctx, "dave", "annette");
    assertEquals(await test.find("ann"), ["annette", "annie", "anna", "anne"]);
    // Following each other comes first, though more follow annette.
    await follow(test.ctx, "annie", "alice");
    assertEquals(await test.find("ann"), ["annie", "annette", "anna", "anne"]);
    // A request alice hasn't accepted counts for nothing.
    await updateProfile(test.ctx, "alice", { locked: true });
    await follow(test.ctx, "anna", "alice");
    assertEquals(await test.find("ann"), ["annie", "annette", "anna", "anne"]);
});

Deno.test("the account at an address comes first, on the first page only", async () => {
    await using test = await openAnns();

    assertEquals(await test.find("@anne@b.example", "alice", { limit: 1 }), ["anne"]);
    assertEquals(await test.find("anne@B.EXAMPLE", "alice", { offset: 1 }), []);
    // A local address is searched as its username.
    assertEquals(await test.find("anna@social.example"), ["anna"]);
    assertEquals(await test.find("anne@b.example", "alice", { following: true }), []);
    assertEquals(await test.find("annie@social.example", "alice", { following: true }), [
        "annie",
    ]);
    assertEquals(await test.find("alice@social.example", "alice", { following: true }), [
        "alice",
    ]);
    // Only the words of a remote address, all of them.
    assertEquals(await test.find("ann@social.example"), ["annie", "annette", "anna", "anne"]);
    assertEquals(await test.find("ann@b.example"), ["anne"]);

    // Ahead of one more followed, within the limit.
    await createLocalAccount(test.ctx, "annabel");
    for (const id of ["carol", "dave", "annette"]) await follow(test.ctx, id, "annabel");
    await indexUnindexedAccounts(test.ctx);
    assertEquals(await test.find("anna@social.example", "alice", { limit: 1 }), ["anna"]);
    assertEquals(await test.find("anna@social.example"), ["anna", "annabel"]);
});

Deno.test("an account Verso doesn't have is looked up only when asked to", async () => {
    await using test = await openAnns();

    assertEquals(await test.find("nobody@b.example"), []);
    assertEquals(test.transport.sent, []);
    assertEquals(await test.find("nobody@b.example", "alice", { resolve: true }), []);
    assertEquals(
        test.transport.sent.map((request) => new URL(request.url).pathname),
        ["/.well-known/webfinger"],
    );
});

Deno.test("without signing in, a short query finds only the account at its address", async () => {
    await using test = await openAnns();

    assertEquals(await test.find("ann", null), []);
    // Not an address without a domain.
    assertEquals(await test.find("anna", null), []);
    assertEquals(await test.find("@anna", null), []);
    assertEquals(await test.find("anne@b.example", null), ["anne"]);
    assertEquals(await test.find("annie", null), ["annie"]);
    assertEquals(await test.find("  ", "alice"), []);
    assertEquals(await test.find("ann", "alice", { limit: 0 }), []);
});
