import { Poll } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Integer } from "../http/schemas.ts";
import type { Context } from "../kernel/context.ts";
import { visibleNote } from "../notes/visibility.ts";
import { findPoll } from "./poll_queries.ts";
import { vote } from "./polls.ts";
import { renderPolls } from "./render.ts";

const PollId = z.object({
    id: z.string().meta({ description: "The ID of the Poll in the database." }),
});

/** The poll `pollId`, as `viewerId` sees it, if they may see its status. */
const shownPoll = async (ctx: Context, pollId: string, viewerId: string | null) => {
    const poll = await findPoll(ctx, pollId);
    const note = poll && await visibleNote(ctx, poll.note_id, viewerId);
    const shown = note && (await renderPolls(ctx, [note], viewerId)).get(note.id);
    if (shown === undefined) throw new NotFound();

    return shown;
};

const docs = "https://docs.joinmastodon.org/methods/polls";

export const pollRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/polls/:id",
        summary: "View a poll",
        description: "View a poll attached to a status.",
        docs: `${docs}/#get`,
        tags: ["polls"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:note" },
        params: PollId,
        responses: { 200: Poll },
        handler: async (ctx, { params, viewer }) => ({
            status: 200,
            body: await shownPoll(ctx, params.id, viewer?.accountId ?? null),
        }),
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/polls/:id/votes",
        summary: "Vote on a poll",
        description: "Vote on a poll attached to a status.",
        docs: `${docs}/#vote`,
        tags: ["polls"],
        auth: { require: "user", scope: "write:statuses", permission: "owner:note" },
        params: PollId,
        body: z.object({
            choices: z.union([Integer.transform((choice) => [choice]), z.array(Integer)])
                .pipe(z.array(z.int()).min(1))
                .meta({
                    description:
                        "Provide your own votes as an index for each option (starting from 0).",
                }),
        }),
        responses: { 200: Poll },
        handler: async (ctx, { params, body, viewer }) => {
            const poll = await vote(ctx, viewer.accountId, params.id, body.choices);
            if (poll === undefined) throw new NotFound();

            return { status: 200, body: await shownPoll(ctx, poll.id, viewer.accountId) };
        },
    }),
];
