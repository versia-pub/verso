import { z } from "zod";
import { watchRoles } from "../accounts/roles.ts";
import { watchToken } from "../auth/tokens.ts";
import { HttpError, NotFound } from "../http/errors.ts";
import { Binary, defineRoute, type Route, Upgrade } from "../http/route.ts";
import type { StreamingLimits } from "../kernel/config_sections.ts";
import type { Context } from "../kernel/context.ts";
import { type Dispatcher, dispatcher } from "./dispatcher.ts";
import { hashtagStreams } from "./hashtags.ts";
import { publicStreams } from "./public.ts";
import { openSession } from "./session.ts";
import type { SharedSessions } from "./shared.ts";
import { streamUser } from "./user.ts";

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
    /**
     * The process's dispatcher, and its sessions of the streams shared by every viewer, once a
     * WebSocket first needs them.
     */
    let processWide: { dispatch: Dispatcher; shared: readonly SharedSessions[] } | undefined;
    const processWideOf = (ctx: Context) => {
        if (processWide) return processWide;

        const dispatch = dispatcher(ctx);
        const shared = [publicStreams(ctx), hashtagStreams(ctx)];
        for (const sessions of shared) dispatch.listen(sessions);
        return processWide = { dispatch, shared };
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
            description:
                "Open a multiplexed WebSocket connection to receive events. A request that " +
                "isn't for a WebSocket finds nothing, as on Mastodon, where that means streaming " +
                "is on the same host.",
            docs: `${docs}/#websocket`,
            tags: ["streaming"],
            auth: { require: "user" },
            tokenElsewhere: true,
            query: z.object({
                stream: z.string().optional().meta({
                    description: "The stream to subscribe to once connected. More can be " +
                        "subscribed to by sending `subscribe` messages.",
                }),
                tag: z.string().optional().meta({
                    description: "When `stream` is `hashtag` or `hashtag:local`, the hashtag to " +
                        "stream.",
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
                            const session = openSession(viewer, socket, query, limits);
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
                            const { dispatch, shared } = processWideOf(ctx);
                            const unstreams = [
                                dispatch.listen(streamUser(ctx, viewer, session)),
                                ...shared.map((sessions) => sessions.add(viewer, session)),
                            ];
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
