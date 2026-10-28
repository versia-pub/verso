import { z } from "zod";
import { watchToken } from "../auth/tokens.ts";
import { NotFound } from "../http/errors.ts";
import { Binary, defineRoute, type Route, Upgrade } from "../http/route.ts";
import { streamPublic } from "./public.ts";
import { openSession } from "./session.ts";
import { streamUser } from "./user.ts";

const docs = "https://docs.joinmastodon.org/methods/streaming";

/** Streaming: events as they happen, over a WebSocket. */
export const streamingRoutes: readonly Route[] = [
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
        description: "Open a multiplexed WebSocket connection to receive events. A request that " +
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
        }),
        headers: z.object({
            upgrade: z.string().optional(),
            "sec-websocket-protocol": z.string().optional(),
        }),
        responses: { 101: Upgrade },
        handler: (ctx, { query, headers, viewer }) => {
            if (headers.upgrade?.toLowerCase() !== "websocket") throw new NotFound();

            return Promise.resolve({
                status: 101,
                // A browser sends the token as the protocol, and wants it accepted.
                protocol: headers["sec-websocket-protocol"]?.split(",")[0]?.trim(),
                socket: (socket) => {
                    socket.onopen = () => {
                        // Events still rendering when it closes are dropped, as Deno doesn't send
                        // on a closed WebSocket.
                        const session = openSession(viewer, socket, query);
                        socket.onmessage = ({ data }) => session.receive(data);

                        // Mastodon closes it too, though without saying why.
                        const unwatch = watchToken(ctx, viewer.tokenId, () => {
                            socket.close(1000, "The access token was revoked");
                        });
                        const unstreams = [
                            streamUser(ctx, viewer, session),
                            streamPublic(ctx, viewer, session),
                        ];
                        socket.onclose = () => {
                            unwatch();
                            for (const unstream of unstreams) unstream();
                        };
                    };
                },
            });
        },
    }),
];
