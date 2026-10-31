import { z } from "zod";
import { watchRoles } from "../accounts/roles.ts";
import { watchToken } from "../auth/tokens.ts";
import { HttpError, NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Binary, Upgrade } from "../http/responses.ts";
import type { StreamingLimits } from "../kernel/config_sections.ts";
import type { Context } from "../kernel/context.ts";
import { findList } from "../lists/list_queries.ts";
import { directStreams } from "./direct.ts";
import { dispatcher, type Sessions } from "./dispatcher.ts";
import { hashtagStreams } from "./hashtags.ts";
import { listStreams } from "./lists.ts";
import { publicStreams } from "./public.ts";
import { openSession } from "./session.ts";
import { userStreams } from "./user.ts";

const docs = "https://docs.joinmastodon.org/methods/streaming";

/**
 * Streaming: events as they happen, over a WebSocket, with each account's WebSockets on this
 * process, and their streams, no more than `limits` allow.
 */
export const streamingRoutes = (limits: StreamingLimits): readonly Route[] => {
    /** How many WebSockets each account has open on this process. */
    const opened = new Map<string, number>();
    const count = (accountId: string, by: number) => {
        const open = (opened.get(accountId) ?? 0) + by;
        opened.set(accountId, open);
        return open;
    };
    /** The process's sessions of each kind of stream, once a WebSocket first needs them. */
    let streams: readonly Sessions[] | undefined;
    const streamsOf = (ctx: Context) => {
        if (streams) return streams;

        const dispatch = dispatcher(ctx);
        streams = [
            userStreams(ctx),
            publicStreams(ctx),
            hashtagStreams(ctx),
            listStreams(ctx),
            directStreams(ctx),
        ];
        for (const sessions of streams) dispatch.listen(sessions);
        return streams;
    };

    return [
        defineRoute({
            method: "GET",
            path: "/api/v1/streaming/health",
            summary: "Check if the server is alive",
            description: "Verify that the streaming service is alive before connecting to it",
            docs: `${docs}/#health`,
            tags: ["streaming"],
            responses: { 200: Binary("text/plain") },
            handler: () => Promise.resolve({ status: 200, file: new TextEncoder().encode("OK") }),
        }),
        defineRoute({
            method: "GET",
            path: "/api/v1/streaming",
            summary: "Establishing a WebSocket connection",
            description: "Open a multiplexed WebSocket connection to receive events. While the " +
                "WebSocket spec allows for both text and binary date frames, since we are " +
                "working only with small text fragments the streaming server uses text frames " +
                "only. Clients should be configured that way if necessary.",
            docs: `${docs}/#websocket`,
            tags: ["streaming"],
            auth: { require: "user" },
            tokenElsewhere: true,
            query: z.object({
                stream: z.string().optional().meta({
                    description: "When attempting to watch a single stream for events. See " +
                        "Streams for possible values.",
                }),
                tag: z.string().optional().meta({
                    description: "When `stream` is set to `hashtag` or `hashtag:local`, use " +
                        "this parameter to specify the tag name.",
                }),
                list: z.string().optional().meta({
                    description: "When `stream` is set to `list`, use this parameter to specify " +
                        "the list ID.",
                }),
            }),
            headers: z.object({
                upgrade: z.string().optional(),
                "sec-websocket-protocol": z.string().optional(),
            }),
            responses: { 101: Upgrade },
            handler: (ctx, { query, headers, viewer }) => {
                if (headers.upgrade?.toLowerCase() !== "websocket") throw new NotFound();
                if ((opened.get(viewer.accountId) ?? 0) >= limits.sockets_per_account) {
                    throw new HttpError(429, "Too many WebSockets are open");
                }

                return Promise.resolve({
                    status: 101,
                    // A browser sends the token as the protocol, and wants it accepted.
                    protocol: headers["sec-websocket-protocol"]?.split(",")[0]?.trim(),
                    socket: (socket) => {
                        socket.onopen = () => {
                            // Counted once open, so a handshake that fails counts for nothing. Those
                            // that open at once past the limit close at once.
                            if (count(viewer.accountId, 1) > limits.sockets_per_account) {
                                socket.onclose = () => count(viewer.accountId, -1);
                                return socket.close(1008, "Too many WebSockets are open");
                            }

                            // Events still rendering when it closes are dropped, as Deno doesn't send
                            // on a closed WebSocket.
                            const session = openSession(
                                viewer,
                                socket,
                                query,
                                limits,
                                async (listId) =>
                                    await findList(ctx, viewer.accountId, listId) !== undefined,
                            );
                            socket.onmessage = ({ data }) => session.receive(data);

                            // Mastodon closes it too, though without saying why.
                            const unwatch = watchToken(ctx, viewer.tokenId, () => {
                                socket.close(1000, "The access token was revoked");
                            });
                            // A socket may stay open for days, through changes to what it may read.
                            const unwatchRoles = watchRoles(
                                ctx,
                                viewer.accountId,
                                viewer.forgetPermissions,
                            );
                            const unstreams = streamsOf(ctx).map((sessions) =>
                                sessions.add(viewer, session)
                            );
                            socket.onclose = () => {
                                count(viewer.accountId, -1);
                                unwatch();
                                unwatchRoles();
                                for (const unstream of unstreams) unstream();
                            };
                        };
                    },
                });
            },
        }),
    ];
};
