/**
 * A client's WebSocket connection to `/api/v1/streaming`: the streams it subscribes to and
 * unsubscribes from, by the messages it sends, as on Mastodon's streaming server.
 * @see https://docs.joinmastodon.org/methods/streaming/#websocket
 * @module
 */
import { z } from "zod";
import type { Viewer } from "../http/route.ts";
import { StreamingLimits } from "../kernel/config_sections.ts";
import { grants, type Scope } from "../kernel/scopes.ts";

/** What a session needs of its WebSocket. */
export type Socket = {
    readonly send: (data: string) => void;
    readonly close: (code: number, reason: string) => void;
};

export type Session = {
    /** Handles a message the client sent, which is text unless the client sent bytes. */
    readonly receive: (data: unknown) => void;
    /**
     * The streams the client is subscribed to, in the order it subscribed, by their names, or for a
     * hashtag's or a list's, by {@link hashtagStream} or {@link listStream}.
     */
    readonly streams: () => readonly string[];
    /** Whether the client is subscribed to any of `streams`. */
    readonly subscribedTo: (streams: readonly string[]) => boolean;
    /**
     * Sends the client an event of `streams`, such as a status as JSON, or a deleted one's id, once
     * for each of them it is subscribed to, as on Mastodon.
     */
    readonly deliver: (streams: readonly string[], event: string, payload: string) => void;
};

/**
 * A stream a client can subscribe to, by the scope it needs, if it isn't public, and whether it is
 * one hashtag's or one list's, which the client names with that parameter.
 */
type Stream = { readonly scope?: Scope; readonly param?: "tag" | "list" };

/** The streams Verso has. Mastodon's `direct` stream isn't among them yet. */
const streams = new Map<string, Stream>([
    ["user", { scope: "read:statuses" }],
    ["user:notification", { scope: "read:notifications" }],
    ["public", {}],
    ["public:media", {}],
    ["public:local", {}],
    ["public:local:media", {}],
    ["public:remote", {}],
    ["public:remote:media", {}],
    ["hashtag", { param: "tag" }],
    ["hashtag:local", { param: "tag" }],
    ["list", { scope: "read:statuses", param: "list" }],
]);

/**
 * How a session names the stream `name` of the hashtag `tag`, which is the same whatever its case,
 * as on Mastodon.
 */
export const hashtagStream = (name: string, tag: string): string => `${name}#${tag.toLowerCase()}`;

/** How a session names the stream of the list `listId`. */
export const listStream = (listId: string): string => `list#${listId}`;

/** The parameters that name a hashtag's or a list's stream. */
type Params = { readonly tag?: string; readonly list?: string };

/** What a client is told when it names no hashtag or list, as on Mastodon. */
const missing = { tag: "Missing tag name parameter", list: "Missing list name parameter" };

/** What a client sends: a stream, or several, of which the first counts, as on Mastodon. */
const Message = z.object({
    type: z.string().optional(),
    stream: z.union([z.string(), z.array(z.string())]).optional(),
    tag: z.string().optional(),
    list: z.string().optional(),
});

/**
 * A session for `viewer` on `socket`, subscribed to `query.stream` if the client asked for one when
 * it connected, of the hashtag `query.tag` or the list `query.list` if it is a hashtag's or a
 * list's. A stream the client may not have, that doesn't exist, that is a hashtag's or a list's but
 * names none, or that is of a list that isn't the viewer's, as `ownsList` answers, is refused with
 * an error message, as on Mastodon. Mastodon checks the scope first, so a stream that doesn't exist
 * needs the scope of one that isn't public. So are a hashtag longer than `limits` allow, and
 * streams past as many as they allow, which Mastodon doesn't limit.
 */
export const openSession = (
    viewer: Viewer,
    socket: Socket,
    query: { readonly stream?: string } & Params = {},
    limits: Pick<StreamingLimits, "subscriptions" | "tag_length"> = StreamingLimits.parse({}),
    ownsList: (listId: string) => Promise<boolean> = () => Promise.resolve(false),
): Session => {
    // Each stream, by how the session names it, as events name it: a hashtag's as the client first
    // wrote it, as on Mastodon.
    const subscribed = new Map<string, readonly string[]>();

    const refuse = (error: string, status: number) =>
        socket.send(JSON.stringify({ error, status }));

    /**
     * What the session names the stream `name`, of the hashtag or list `params` name if it is a
     * hashtag's or a list's.
     */
    const keyOf = (name: string, stream: Stream, params: Params) => {
        if (stream.param === undefined) return name;

        // An empty one is none, as on Mastodon.
        const value = params[stream.param];
        if (value) return stream.param === "tag" ? hashtagStream(name, value) : listStream(value);
    };

    // A missing stream is named "", which no stream is.
    const subscribe = (name: string, params: Params) => {
        const stream = streams.get(name);

        const scope = stream ? stream.scope : "read:statuses";
        if (scope && !grants(viewer.scopes, scope)) {
            return refuse("Access token does not have the required scopes", 401);
        }
        if (!stream) return refuse("Unknown stream type", 400);

        const key = keyOf(name, stream, params);
        if (key === undefined) return refuse(missing[stream.param ?? "tag"], 400);
        if (subscribed.has(key)) return;
        // In characters, as Verso counts them.
        if (stream.param === "tag" && [...(params.tag ?? "")].length > limits.tag_length) {
            return refuse("Tag name is too long", 400);
        }
        if (subscribed.size >= limits.subscriptions) return refuse("Too many subscriptions", 400);

        const value = stream.param && params[stream.param];
        if (stream.param !== "list" || value === undefined) {
            subscribed.set(key, value ? [name, value] : [name]);
            return;
        }

        // Only the owner's lists are theirs to stream, which takes a query to know.
        void ownsList(value).then((owns) => {
            if (!owns) return refuse("Not authorized to stream this list", 401);
            if (subscribed.size >= limits.subscriptions) {
                return refuse("Too many subscriptions", 400);
            }

            subscribed.set(key, [name, value]);
        }, () => refuse("Not authorized to stream this list", 401));
    };

    const unsubscribe = (name: string, params: Params) => {
        const stream = streams.get(name);
        const key = stream && keyOf(name, stream, params);
        if (key === undefined) {
            return socket.send(JSON.stringify({ error: "Error unsubscribing from channel" }));
        }

        subscribed.delete(key);
    };

    if (query.stream !== undefined) subscribe(query.stream, query);

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
            if (message.type === "subscribe") subscribe(name, message);
            if (message.type === "unsubscribe") unsubscribe(name, message);
        },
        streams: () => [...subscribed.keys()],
        subscribedTo: (streams) => streams.some((name) => subscribed.has(name)),
        deliver: (streams, event, payload) => {
            for (const [key, stream] of subscribed) {
                if (streams.includes(key)) socket.send(JSON.stringify({ stream, event, payload }));
            }
        },
    };
};
