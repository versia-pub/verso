/**
 * A client's WebSocket connection to `/api/v1/streaming`: the streams it subscribes to and
 * unsubscribes from, by the messages it sends, as on Mastodon's streaming server.
 * @see https://docs.joinmastodon.org/methods/streaming/#websocket
 * @module
 */
import { z } from "zod";
import type { Viewer } from "../http/route.ts";
import { grants, type Scope } from "../kernel/scopes.ts";

/** What a session needs of its WebSocket. */
export type Socket = {
    readonly send: (data: string) => void;
    readonly close: (code: number, reason: string) => void;
};

export type Session = {
    /** Handles a message the client sent, which is text unless the client sent bytes. */
    readonly receive: (data: unknown) => void;
    /** The streams the client is subscribed to, in the order it subscribed. */
    readonly streams: () => readonly string[];
    /** Whether the client is subscribed to any of `streams`. */
    readonly subscribedTo: (streams: readonly string[]) => boolean;
    /**
     * Sends the client an event of `streams`, such as a status as JSON, or a deleted one's id, once
     * for each of them it is subscribed to, as on Mastodon.
     */
    readonly deliver: (streams: readonly string[], event: string, payload: string) => void;
};

/** A stream a client can subscribe to, by the scope it needs, if it isn't public. */
type Stream = { readonly scope?: Scope };

/** The streams Verso has. Mastodon's `direct`, `list` and `hashtag` streams aren't among them yet. */
const streams = new Map<string, Stream>([
    ["user", { scope: "read:statuses" }],
    ["user:notification", { scope: "read:notifications" }],
    ["public", {}],
    ["public:media", {}],
    ["public:local", {}],
    ["public:local:media", {}],
    ["public:remote", {}],
    ["public:remote:media", {}],
]);

/** What a client sends: a stream, or several, of which the first counts, as on Mastodon. */
const Message = z.object({
    type: z.string().optional(),
    stream: z.union([z.string(), z.array(z.string())]).optional(),
});

/**
 * A session for `viewer` on `socket`, subscribed to `query.stream` if the client asked for one when
 * it connected. A stream the client may not have, or that doesn't exist, is refused with an error
 * message, as on Mastodon. Mastodon checks the scope first, so a stream that doesn't exist needs
 * the scope of one that isn't public.
 */
export const openSession = (
    viewer: Viewer,
    socket: Socket,
    query: { readonly stream?: string } = {},
): Session => {
    const subscribed = new Set<string>();

    const refuse = (error: string, status: number) =>
        socket.send(JSON.stringify({ error, status }));

    // A missing stream is named "", which no stream is.
    const subscribe = (name: string) => {
        const stream = streams.get(name);

        const scope = stream ? stream.scope : "read:statuses";
        if (scope && !grants(viewer.scopes, scope)) {
            return refuse("Access token does not have the required scopes", 401);
        }
        if (!stream) return refuse("Unknown stream type", 400);

        subscribed.add(name);
    };

    const unsubscribe = (name: string) => {
        if (!streams.has(name)) {
            return socket.send(JSON.stringify({ error: "Error unsubscribing from channel" }));
        }

        subscribed.delete(name);
    };

    if (query.stream !== undefined) subscribe(query.stream);

    return {
        receive: (data) => {
            if (typeof data !== "string") {
                return socket.close(1003, "Verso's streaming doesn't support binary messages");
            }

            let message: z.infer<typeof Message>;
            try {
                message = Message.parse(JSON.parse(data));
            } catch {
                return;
            }

            const name = (Array.isArray(message.stream) ? message.stream[0] : message.stream) ?? "";
            if (message.type === "subscribe") subscribe(name);
            if (message.type === "unsubscribe") unsubscribe(name);
        },
        streams: () => [...subscribed],
        subscribedTo: (streams) => streams.some((name) => subscribed.has(name)),
        deliver: (streams, event, payload) => {
            for (const name of subscribed) {
                if (streams.includes(name)) {
                    socket.send(JSON.stringify({ stream: [name], event, payload }));
                }
            }
        },
    };
};
