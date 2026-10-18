import { assertEquals } from "@std/assert";
import { createInstance } from "../instances/testing.ts";
import { findMedia } from "../media/media.ts";
import { createTestContext } from "../testing/context.ts";
import { findAccount, type RemoteProfile } from "./accounts.ts";
import { type RemoteAccount, saveRemoteAccount } from "./remote.ts";

const profile: RemoteProfile = {
    username: "bob",
    display_name: "Bob",
    note: "",
    note_format: "text/plain",
    note_html: "<p>Hi</p>",
    fields: [],
    locked: false,
    indexable: true,
};

const bob: RemoteAccount = {
    instanceId: "b.example",
    remoteId: "abc",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    profile,
    avatar: { url: "https://b.example/bob.png", mediaType: "image/png", width: 64 },
    header: null,
};

const open = async () => {
    const test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    return test;
};

Deno.test("a remote account is saved once, and replaced when it is saved again", async () => {
    await using test = await open();

    const id = await saveRemoteAccount(test.ctx, bob);
    test.clock.advance(60_000);
    const again = await saveRemoteAccount(test.ctx, {
        ...bob,
        profile: { ...profile, display_name: "Robert", locked: true },
    });

    assertEquals(again, id);
    const row = await findAccount(test.ctx, id);
    assertEquals(
        [row?.domain, row?.remote_id, row?.display_name, row?.locked, row?.created_at],
        ["b.example", "abc", "Robert", true, new Date("2026-01-01T00:00:00Z")],
    );
    assertEquals(row?.fetched_at, test.clock.now());
    assertEquals((await test.ctx.db.selectFrom("accounts").select("id").execute()).length, 1);
});

Deno.test("a remote account's pictures are saved over the old ones, or deleted when gone", async () => {
    await using test = await open();
    const pictures = async (id: string) => {
        const row = await findAccount(test.ctx, id);
        return { avatar: row?.avatar_id ?? null, header: row?.header_id ?? null };
    };

    const id = await saveRemoteAccount(test.ctx, bob);
    const first = await pictures(id);
    assertEquals((await findMedia(test.ctx, first.avatar ?? ""))?.width, 64);
    assertEquals(first.header, null);

    const header = { url: "https://b.example/sea.jpg", mediaType: "image/jpeg" };
    await saveRemoteAccount(test.ctx, {
        ...bob,
        avatar: { url: "https://b.example/bob.webp", mediaType: "image/webp" },
        header,
    });
    const second = await pictures(id);
    assertEquals(second.avatar, first.avatar);
    assertEquals(
        (await findMedia(test.ctx, second.avatar ?? ""))?.url,
        "https://b.example/bob.webp",
    );
    assertEquals((await findMedia(test.ctx, second.header ?? ""))?.url, header.url);

    await saveRemoteAccount(test.ctx, { ...bob, avatar: null, header });
    assertEquals(await pictures(id), { avatar: null, header: second.header });
    assertEquals(await findMedia(test.ctx, first.avatar ?? ""), undefined);
    assertEquals((await test.ctx.db.selectFrom("media").select("id").execute()).length, 1);
});
