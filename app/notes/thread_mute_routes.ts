import { Status } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { renderStatuses } from "./render.ts";
import { setThreadMuted } from "./thread_mutes.ts";

/** Mutes the thread of a status, or unmutes it. */
const threadMuteRoute = (action: "mute" | "unmute") =>
    defineRoute({
        method: "POST",
        path: `/api/v1/statuses/:id/${action}`,
        ...action === "mute"
            ? {
                summary: "Mute a conversation",
                description: "Do not receive notifications for the thread that this status is " +
                    "part of. Must be a thread in which you are a participant.",
                docs: "https://docs.joinmastodon.org/methods/statuses/#mute",
            }
            : {
                summary: "Unmute a conversation",
                description: "Start receiving notifications again for the thread that this " +
                    "status is part of.",
                docs: "https://docs.joinmastodon.org/methods/statuses/#unmute",
            },
        tags: ["statuses"],
        auth: { require: "user", scope: "write:mutes", permission: "owner:mute" },
        params: z.object({ id: z.string() }),
        responses: { 200: Status },
        handler: async (ctx, { params, viewer }) => {
            const note = await setThreadMuted(ctx, viewer.accountId, params.id, action === "mute");
            if (note === undefined) throw new NotFound();

            const [status] = await renderStatuses(ctx, [note], viewer.accountId);
            return { status: 200, body: status };
        },
    });

export const threadMuteRoutes: readonly Route[] = [
    threadMuteRoute("mute"),
    threadMuteRoute("unmute"),
];
