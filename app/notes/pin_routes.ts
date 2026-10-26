import { NotFound, Unprocessable } from "../http/errors.ts";
import { defineRoute } from "../http/route.ts";
import { pin, pinLimit, unpin } from "./pins.ts";
import { renderStatuses } from "./render.ts";
import { Status } from "@versia/client-api";
import { z } from "zod";

/** Pins one of the viewer's statuses to their profile. */
export const pinRoute = defineRoute({
    method: "POST",
    path: "/api/v1/statuses/:id/pin",
    summary: "Pin status to profile",
    description: "Feature one of your own public statuses at the top of your profile.\n\n" +
        `Like Mastodon, Verso lets an account pin its public, unlisted and private statuses, ` +
        `up to ${pinLimit} of them.`,
    docs: "https://docs.joinmastodon.org/methods/statuses/#pin",
    tags: ["statuses"],
    auth: { require: "user", scope: "write:accounts", permission: "owner:note" },
    params: z.object({ id: z.string() }),
    responses: { 200: Status },
    handler: async (ctx, { params, viewer }) => {
        const result = await pin(ctx, viewer.accountId, params.id);
        if (result === "missing") throw new NotFound();
        if (result === "unpinnable") {
            throw new Unprocessable("Only one's own statuses, not reblogs nor direct ones");
        }
        if (result === "full") {
            throw new Unprocessable(`At most ${pinLimit} statuses can be pinned`);
        }

        const [status] = await renderStatuses(ctx, [result], viewer.accountId);
        return { status: 200, body: status };
    },
});

/** Unpins one of the viewer's statuses from their profile. */
export const unpinRoute = defineRoute({
    method: "POST",
    path: "/api/v1/statuses/:id/unpin",
    summary: "Unpin status from profile",
    description: "Unfeature a status from the top of your profile.",
    docs: "https://docs.joinmastodon.org/methods/statuses/#unpin",
    tags: ["statuses"],
    auth: { require: "user", scope: "write:accounts", permission: "owner:note" },
    params: z.object({ id: z.string() }),
    responses: { 200: Status },
    handler: async (ctx, { params, viewer }) => {
        const note = await unpin(ctx, viewer.accountId, params.id);
        if (note === undefined) throw new NotFound();

        const [status] = await renderStatuses(ctx, [note], viewer.accountId);
        return { status: 200, body: status };
    },
});
