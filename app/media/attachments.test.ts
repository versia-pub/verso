import { assertEquals } from "@std/assert";
import { encode } from "fast-png";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { Limits } from "../kernel/config.ts";
import { pin } from "../notes/pins.ts";
import { noteRoutes } from "../notes/routes.ts";
import { timelineRoutes } from "../notes/timeline_routes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { findMedia } from "./media.ts";
import { upload } from "./uploads.ts";

const png = new Uint8Array(encode({
    width: 2,
    height: 2,
    data: new Uint8Array(16).fill(200),
    channels: 4,
}));

type Attachment = { id: string; description: string | null };

/** A file's id, and its description, if it has one. */
const described = (media: Attachment) =>
    media.description === null ? media.id : `${media.id}: ${media.description}`;

const zip = (n: number) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, n]);

const open = async (limits = Limits.parse({})) => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, [...noteRoutes(limits), ...timelineRoutes], {
        checkResponses: true,
    });
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);

    /** Posts a status as alice, in JSON, or as a form if `body` is a string. */
    const post = async (body: Record<string, unknown> | string, method = "POST", path = "") => {
        const response = await app.request(`/api/v1/statuses${path}`, {
            method,
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
        (await upload(test.ctx, accountId, {
            file: new Blob([bytes]),
            mediaType: "application/zip",
        })).id;

    const notes = async () => (await test.ctx.db.selectFrom("notes").select("id").execute()).length;

    /** Edits alice's status `id`, as {@link post} posts one. */
    const edit = (id: string, body: Record<string, unknown> | string) =>
        post(body, "PUT", `/${id}`);

    /** The ids of the files each version of the status `id` had, oldest first. */
    const history = async (id: string) => {
        const response = await app.request(`/api/v1/statuses/${id}/history`, {
            headers: { authorization: `Bearer ${await tokenFor(test.ctx, "alice")}` },
        });
        const versions: { media_attachments: Attachment[] }[] = await response.json();

        return versions.map((version) => version.media_attachments.map(described));
    };

    return { ...test, app, post, edit, history, uploaded, notes };
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

    const broken = await test.uploaded(
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("oops")]),
    );
    await drain(test.ctx, queues);
    assertEquals(await refused([broken]), [422, `Media failed to process: ${broken}`]);
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

Deno.test("an edit attaches files in place of the status's, and its history keeps both", async () => {
    await using test = await open();
    const [a, b, c] = [
        await test.uploaded(zip(1)),
        await test.uploaded(zip(2)),
        await test.uploaded(zip(3)),
    ];
    const { body } = await test.post({ status: "Hi", media_ids: [a, b] });

    // Given as they are, they are left as they were, and the status isn't edited.
    await test.edit(body.id, { status: "Hi", media_ids: [a, b, a] });
    assertEquals(await test.history(body.id), [[a, b]]);

    const edited = await test.edit(body.id, { status: "Hi", media_ids: [c, b] });

    assertEquals(edited.status, 200);
    assertEquals(edited.body.media_attachments.map(described), [c, b]);
    assertEquals(await test.history(body.id), [[a, b], [c, b]]);

    // Files are enough, without text.
    assertEquals((await test.edit(body.id, { status: "", media_ids: [b] })).status, 200);

    // What the edit removed can be attached again.
    assertEquals((await test.post({ status: "Again", media_ids: [a] })).status, 200);
});

Deno.test("an edit that leaves files out keeps them, and can describe them", async () => {
    await using test = await open();
    const [a, other] = [await test.uploaded(zip(1)), await test.uploaded(zip(2))];
    const { body } = await test.post({ status: "Hi", media_ids: [a] });

    const attributes = (...changes: Record<string, string>[]) =>
        test.edit(body.id, { status: "Hi", media_attributes: changes });

    // An empty description is none, as the file has.
    await attributes({ id: a, description: "" });
    assertEquals(await test.history(body.id), [[a]]);

    const edited = await attributes(
        { id: a, description: "Notes", focus: "0,1" },
        // Only the files attached are changed.
        { id: other, description: "Other" },
    );

    assertEquals(edited.body.media_attachments.map(described), [`${a}: Notes`]);
    assertEquals(edited.body.media_attachments[0].meta, { focus: { x: 0, y: 1 } });
    assertEquals((await findMedia(test.ctx, other))?.description, null);
    assertEquals(await test.history(body.id), [[a], [`${a}: Notes`]]);

    // Described as they are, they are left as they were, and the status isn't edited again.
    await attributes({ id: a, description: "Notes", focus: "0,1" }, {
        id: other,
        description: "Other",
    });
    assertEquals((await test.history(body.id)).length, 2);

    // Moving the focus on either axis is an edit.
    await attributes({ id: a, focus: "0,0.5" });
    await attributes({ id: a, focus: "1,0.5" });
    assertEquals((await test.history(body.id)).length, 4);

    // Forms give changes by index.
    const form = await test.edit(
        body.id,
        `status=Hi&media_attributes[0][id]=${a}&media_attributes[0][description]=Mine`,
    );
    assertEquals(form.body.media_attachments.map(described), [`${a}: Mine`]);
});

Deno.test("an edit is held to what posting is, and changes nothing if refused", async () => {
    await using test = await open(Limits.parse({ attachments: 1 }));
    const a = await test.uploaded(zip(1));
    const bobs = await test.uploaded(zip(2), "bob");
    const { body } = await test.post({ status: "Hi", media_ids: [a] });

    const refused = await test.edit(body.id, { status: "Bye", media_ids: [bobs] });
    assertEquals([refused.status, refused.body.error_description], [
        422,
        `Media not found: ${bobs}`,
    ]);
    assertEquals((await test.edit(body.id, { status: "Bye", media_ids: [a, bobs] })).body.details, {
        "body.media_ids": ["At most 1 files can be attached"],
    });
    assertEquals((await test.edit(body.id, { status: " " })).body.details, {
        "body.status": ["Can't be blank without attachments"],
    });

    const fetched = await (await test.app.request(`/api/v1/statuses/${body.id}`)).json();
    assertEquals([fetched.content, fetched.media_attachments.map(described)], ["<p>Hi</p>", [a]]);
});

Deno.test("asked only for statuses with media, an account and the public timeline give those", async () => {
    await using test = await open();
    const plain = (await test.post({ status: "Plain" })).body.id;
    const file = await test.uploaded(zip(1));
    const attached = (await test.post({ status: "Notes", media_ids: [file] })).body.id;
    await pin(test.ctx, "alice", plain);
    await pin(test.ctx, "alice", attached);

    const ids = async (path: string) => {
        const response = await test.app.request(path);
        return (await response.json()).map((status: { id: string }) => status.id);
    };

    assertEquals(await ids("/api/v1/accounts/alice/statuses"), [attached, plain]);
    assertEquals(await ids("/api/v1/accounts/alice/statuses?only_media=true"), [attached]);
    assertEquals(await ids("/api/v1/accounts/alice/statuses?pinned=true"), [attached, plain]);
    assertEquals(await ids("/api/v1/accounts/alice/statuses?pinned=true&only_media=true"), [
        attached,
    ]);
    assertEquals(await ids("/api/v1/timelines/public"), [attached, plain]);
    assertEquals(await ids("/api/v1/timelines/public?only_media=true"), [attached]);
});
