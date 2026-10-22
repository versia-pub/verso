import { assertEquals, assertNotEquals } from "@std/assert";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { findRemoteEmoji } from "./emoji_queries.ts";
import { keepRemoteEmojis, type RemoteEmoji } from "./emojis.ts";

const emoji = (shortcode: string, url: string): RemoteEmoji => ({
    shortcode,
    picture: { url, mediaType: "image/png" },
});

Deno.test("an instance has one emoji by each name, its picture the latest given", async () => {
    await using test = await createTestContext();
    for (const domain of ["b.example", "c.example"]) await createInstance(test.ctx, domain);
    const picture = async (instanceId: string, shortcode: string) => {
        const row = await findRemoteEmoji(test.ctx, instanceId, shortcode);
        const media = row && await test.ctx.db.selectFrom("media").select("url")
            .where("id", "=", row.media_id).executeTakeFirst();
        return [row?.id, media?.url];
    };

    const first = await keepRemoteEmojis(test.ctx, "b.example", [
        emoji("blob", "https://b.example/blob.png"),
        emoji("cat", "https://b.example/cat.png"),
    ]);
    const [blob, cat] = first;
    assertEquals(await picture("b.example", "blob"), [blob, "https://b.example/blob.png"]);

    // Named again, it is the same emoji, with the new picture in place of the old one.
    assertEquals(
        await keepRemoteEmojis(test.ctx, "b.example", [emoji("blob", "https://b.example/new.png")]),
        [blob],
    );
    assertEquals(await picture("b.example", "blob"), [blob, "https://b.example/new.png"]);
    assertEquals(await picture("b.example", "cat"), [cat, "https://b.example/cat.png"]);
    assertEquals(
        (await test.ctx.db.selectFrom("media").select("id").execute()).length,
        2,
    );

    // Another instance's emoji by the same name is another emoji.
    const [theirs] = await keepRemoteEmojis(test.ctx, "c.example", [
        emoji("blob", "https://c.example/blob.png"),
    ]);
    assertNotEquals(theirs, blob);
    assertEquals(await picture("b.example", "blob"), [blob, "https://b.example/new.png"]);
});
