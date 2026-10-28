import { assertEquals, assertRejects } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import { findRemoteNoteAt } from "../notes/note_queries.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { createTestContext } from "../testing/context.ts";
import { resolveUrl } from "./urls.ts";

Deno.test("an entity URL finds the local account or status it names, if the viewer may see it", async () => {
    await using test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    const open = await createNote(test.ctx, "bob");
    const closed = await createNote(test.ctx, "bob", { visibility: "private" });
    const share = await createShare(test.ctx, "bob", open.id);
    const entities = "https://social.example/.versia/v0.6/entities";

    /** What alice finds at `url`: an account's username or a status's id. */
    const find = async (url: string) => {
        const found = await resolveUrl(test.ctx, url, "alice");
        return found?.type === "accounts" ? found.account.username : found?.note.id;
    };

    assertEquals(await find(`${entities}/User/bob`), "bob");
    assertEquals(await find(`${entities}/Note/${open.id}`), open.id);
    assertEquals(
        await find(`http://SOCIAL.example/.versia/v0.6/entities/Note/${open.id}`),
        open.id,
    );
    assertEquals(await find(`${entities}/Note/${closed.id}`), undefined);
    await follow(test.ctx, "alice", "bob");
    assertEquals(await find(`${entities}/Note/${closed.id}`), closed.id);

    for (
        const url of [
            `${entities}/User/nobody`,
            `${entities}/Note/bob`,
            `${entities}/User/${open.id}`,
            // Boosts aren't statuses here.
            `${entities}/pub.versia%3Ashare%2FShare/${share.id}`,
            `${entities}/Note/${share.id}`,
            `${entities}/Note/${open.id}/extra`,
            `${entities}/Note/%62ob`,
            `https://social.example/bob/.versia/v0.6/entities/Note/${open.id}`,
            `https://social.example/@bob/${open.id}`,
            "https://",
            "bob",
        ]
    ) {
        assertEquals(await find(url), undefined, url);
    }
    assertEquals(test.transport.sent, []);
});

Deno.test("an entity URL on a remote instance is fetched, unless it fails", async () => {
    await using network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    const alice = await createLocalAccount(a, "alice");
    b.serve("/.versia/v0.6/entities/User/carol", {
        type: "User",
        id: "carol",
        created_at: "2026-01-01T00:00:00Z",
        username: "carol",
        fields: [],
        manually_approves_followers: false,
        indexable: true,
    });
    for (const [id, group] of [["n1", "public"], ["n2", "followers"]]) {
        b.serve(`/.versia/v0.6/entities/Note/${id}`, {
            type: "Note",
            id,
            created_at: "2026-01-01T00:00:00Z",
            author: "carol",
            content: { "text/plain": { content: "Hi", remote: false } },
            group,
            is_sensitive: false,
            mentions: [],
            attachments: [],
            previews: [],
        });
    }
    const entities = "https://b.test/.versia/v0.6/entities";

    /** What alice finds at `url`: an account's remote id or a status's. */
    const find = async (url: string) => {
        const found = await resolveUrl(a, url, alice);
        return found?.type === "accounts" ? found.account.remote_id : found?.note.remote_id;
    };

    assertEquals(await find(`${entities}/User/carol`), "carol");
    assertEquals(await find(`${entities}/Note/n1`), "n1");
    // Fetched, but for carol's followers only.
    assertEquals(await find(`${entities}/Note/n2`), undefined);
    assertEquals((await findRemoteNoteAt(a, "b.test", "n2"))?.visibility, "private");
    assertEquals(await find(`${entities}/Note/n3`), undefined);
    assertEquals(await find("https://c.test/.versia/v0.6/entities/User/dan"), undefined);
    // Each URL names what its own instance has.
    assertEquals(await find("https://a.test/.versia/v0.6/entities/Note/b.test:n1"), undefined);
});

Deno.test("a failure other than a remote instance's isn't hidden", async () => {
    await using test = await createTestContext({
        federation: { resolve: () => Promise.reject(new Error("Broken")) },
    });

    await assertRejects(
        () => resolveUrl(test.ctx, "https://b.test/.versia/v0.6/entities/User/bob", "alice"),
        Error,
        "Broken",
    );
});
