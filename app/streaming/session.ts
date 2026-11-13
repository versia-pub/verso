/**
 * A client's WebSocket connection to `/api/v1/streaming`: the streams it subscribes to and
 * unsubscribes from, by the messages it sends.
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
    /** Handles a message the client sent. It is text, unless the client sent bytes. */
    readonly receive: (data: unknown) => void;
    /**
     * The streams the client is subscribed to, in the order it subscribed. A hashtag's or a list's
     * is named by {@link hashtagStream} or {@link listStream}, any other by its name.
     */
    readonly streams: () => readonly string[];
    /** Whether the client is subscribed to any of `streams`. */
    readonly subscribedTo: (streams: readonly string[]) => boolean;
    /**
     * Sends the client an event once for each of `streams` it is subscribed to. The payload is a
     * string, like a status as JSON or a deleted one's id. Some events, like `filters_changed`,
     * have none.
     */
    readonly deliver: (streams: readonly string[], event: string, payload?: string) => void;
};

/**
 * A stream a client can subscribe to: the scope it needs, and `param`, the parameter that names its
 * hashtag or list, if it is one hashtag's or one list's.
 */
type Stream = { readonly scope: Scope; readonly param?: "tag" | "list" };

/** The streams Verso has, which are Mastodon's. */
const streams = new Map<string, Stream>([
    ["user", { scope: "read:statuses" }],
    ["user:notification", { scope: "read:notifications" }],
    ["public", { scope: "read:statuses" }],
    ["public:media", { scope: "read:statuses" }],
    ["public:local", { scope: "read:statuses" }],
    ["public:local:media", { scope: "read:statuses" }],
    ["public:remote", { scope: "read:statuses" }],
    ["public:remote:media", { scope: "read:statuses" }],
    ["hashtag", { scope: "read:statuses", param: "tag" }],
    ["hashtag:local", { scope: "read:statuses", param: "tag" }],
    ["list", { scope: "read:statuses", param: "list" }],
    ["direct", { scope: "read:statuses" }],
]);

/** How a session names the stream `name` of the hashtag `tag`, whatever the case of `tag`. */
export const hashtagStream = (name: string, tag: string): string => `${name}#${tag.toLowerCase()}`;

/** How a session names the stream of the list `listId`. */
export const listStream = (listId: string): string => `list#${listId}`;

/** The parameters that name a hashtag's or a list's stream. */
type Params = { readonly tag?: string; readonly list?: string };

/** Mastodon's wording of what a client is told when it names no hashtag or list. */
const missing = { tag: "Missing tag name parameter", list: "Missing list name parameter" };

/** What a client sends: a stream, or several, of which only the first counts. */
const Message = z.object({
    type: z.string().optional(),
    stream: z.union([z.string(), z.array(z.string())]).optional(),
    tag: z.string().optional(),
    list: z.string().optional(),
});

/**
 * A session for `viewer` on `socket`, subscribed to `query.stream` if the client asked for one when
 * it connected, with `query.tag` or `query.list` naming a hashtag's or a list's.
 *
 * It refuses with an error message a stream the client may not have, that doesn't exist, that is a
 * hashtag's or a list's but names none, or that is a list that isn't the viewer's, as `ownsList`
 * answers. Mastodon checks the scope first, so a stream that doesn't exist needs the scope of one
 * that isn't public. It also refuses a hashtag longer than `limits` allow, and streams past as many
 * as they allow, which Mastodon doesn't limit.
 */
export const openSession = (
    viewer: Viewer,
    socket: Socket,
    query: { readonly stream?: string } & Params = {},
    limits: Pick<StreamingLimits, "subscriptions" | "tag_length"> = StreamingLimits.parse({}),
    ownsList: (listId: string) => Promise<boolean> = () => Promise.resolve(false),
): Session => {
    // Each stream, by how the session names it, with its name as events show it. A hashtag's stays
    // as the client first wrote it, because Mastodon keeps it that way.
    const subscribed = new Map<string, readonly string[]>();

    const refuse = (error: string, status: number) =>
        socket.send(JSON.stringify({ error, status }));

    /**
     * How the session names the stream `name`, with the hashtag or list `params` name if it is a
     * hashtag's or a list's.
     */
    const keyOf = (name: string, stream: Stream, params: Params) => {
        if (stream.param === undefined) return name;

        // An empty one counts as none.
        const value = params[stream.param];
        if (value) return stream.param === "tag" ? hashtagStream(name, value) : listStream(value);
    };

    // A missing stream is named "", which no stream is.
    const subscribe = (name: string, params: Params) => {
        const stream = streams.get(name);

        // The scope of one that doesn't exist is the scope most streams need.
        const scope = stream ? stream.scope : "read:statuses";
        if (!grants(viewer.scopes, scope)) {
            return refuse("Access token does not have the required scopes", 401);
        }
        if (!stream) return refuse("Unknown stream type", 400);

        const key = keyOf(name, stream, params);
        if (key === undefined) return refuse(missing[stream.param ?? "tag"], 400);
        if (subscribed.has(key)) return;

        // In code points, not bytes or UTF-16 code units.
        if (stream.param === "tag" && [...(params.tag ?? "")].length > limits.tag_length) {
            return refuse("Tag name is too long", 400);
        }
        if (subscribed.size >= limits.subscriptions) return refuse("Too many subscriptions", 400);

        const value = stream.param && params[stream.param];
        if (stream.param !== "list" || value === undefined) {
            subscribed.set(key, value ? [name, value] : [name]);
            return;
        }

        // Only a list's owner may stream it, and checking that takes a query.
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
