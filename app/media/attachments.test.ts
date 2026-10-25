import { assertEquals } from "@std/assert";
import { encode } from "fast-png";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { Limits } from "../kernel/config.ts";
import { noteRoutes } from "../notes/routes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { upload } from "./uploads.ts";

const png = new Uint8Array(encode({
    width: 2,
    height: 2,
    data: new Uint8Array(16).fill(200),
    channels: 4,
}));

const zip = (n: number) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, n]);

const open = async (limits = Limits.parse({})) => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, noteRoutes(limits), { checkResponses: true });
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);

    /** Posts a status as alice, in JSON, or as a form if `body` is a string. */
    const post = async (body: Record<string, unknown> | string) => {
        const response = await app.request("/api/v1/statuses", {
            method: "POST",
            headers: {
                authorization: `Bearer ${await tokenFor(test.ctx, "alice")}`,
                "content-type": typeof body === "string"
                    ? "application/x-www-form-urlencoded"
                    : "application/json",
            },
            body: typeof body === "string" ? body : JSON.stringify(body),
        });

        return { status: response.status, body: await response.json() };
    };

    /** The id of a file `accountId` uploads. */
    const uploaded = async (bytes: Uint8Array<ArrayBuffer>, accountId = "alice") =>
        (await upload(test.ctx, accountId, { bytes, mediaType: "application/zip" })).id;

    const notes = async () => (await test.ctx.db.selectFrom("notes").select("id").execute()).length;

    return { ...test, app, post, uploaded, notes };
};

Deno.test("files are attached in the order given, and shown with the status", async () => {
    await using test = await open();
    const picture = await test.uploaded(png);
    const file = await test.uploaded(zip(1));
    await drain(test.ctx, queues);

    const posted = await test.post({ status: "", media_ids: [picture, file, picture] });

    assertEquals(posted.status, 200);
    const attached = posted.body.media_attachments;
    assertEquals(attached.map((media: { id: string }) => media.id), [picture, file]);
    assertEquals(attached.map((media: { type: string }) => media.type), ["image", "unknown"]);
    assertEquals(attached[1].url.startsWith("https://social.example/media/"), true);

    const fetched = await test.app.request(`/api/v1/statuses/${posted.body.id}`);
    assertEquals((await fetched.json()).media_attachments, attached);
});

Deno.test("only one's own uploads, processed and not attached yet, can be attached", async () => {
    await using test = await open();
    const attached = await test.uploaded(zip(1));
    await test.post({ status: "First", media_ids: [attached] });
    const bobs = await test.uploaded(zip(2), "bob");
    const processing = await test.uploaded(png);
    const notes = await test.notes();

    const refused = async (ids: string[]) => {
        const reply = await test.post({ status: "Hi", media_ids: ids });
        return [reply.status, reply.body.error_description];
    };

    assertEquals(await refused([attached, "nope"]), [422, `Media not found: ${attached}, nope`]);
    assertEquals(await refused([bobs]), [422, `Media not found: ${bobs}`]);
    assertEquals(await refused([processing]), [
        422,
        `Media still being processed: ${processing}`,
    ]);
    assertEquals(await test.notes(), notes);
});

Deno.test("a status has at most as many files as configured, and isn't blank without", async () => {
    await using test = await open(Limits.parse({ attachments: 2 }));
    const [a, b, c] = [await test.uploaded(zip(1)), await test.uploaded(zip(2)), "c"];

    assertEquals((await test.post({ status: "Hi", media_ids: [a, b, c] })).body.details, {
        "body.media_ids": ["At most 2 files can be attached"],
    });
    assertEquals((await test.post({ status: " " })).body.details, {
        "body.status": ["Can't be blank without attachments"],
    });

    // Forms give one id, or several.
    const one = await test.post(`media_ids=${a}`);
    const two = await test.post(`media_ids[]=${b}&media_ids[]=${b}`);
    assertEquals([one.status, one.body.media_attachments.length], [200, 1]);
    assertEquals([two.status, two.body.media_attachments.length], [200, 1]);
});
